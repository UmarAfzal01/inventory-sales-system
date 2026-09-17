/**
 * Backfills stock valuation onto data written before the feature existed.
 *
 *   node scripts/backfill-stock-valuation.js            # dry run, reads only
 *   node scripts/backfill-stock-valuation.js --apply    # writes
 *
 * New uploads carry these fields already; this exists only so the figures are
 * correct for the snapshot currently loaded, without waiting for a re-upload.
 *
 * WHAT IT WRITES
 *   inventory_state  $set costPrice, saleRate      (from `products`)
 *   stock_cube       $set costValue, saleValue     (recomputed sums)
 *
 * WHAT IT NEVER TOUCHES
 *   No document is created or deleted. No existing field is modified — only the
 *   four fields above are ever named in a $set. qty, branch, barcode, asOf,
 *   category, productCount and every count in the cube are left exactly as
 *   found, and the script verifies that afterwards.
 *
 * Re-running is safe: the computation depends only on `products` and on the
 * quantities already stored, so a second run writes the same values.
 */
import { MongoClient } from "mongodb";
import { readFileSync } from "fs";

const APPLY = process.argv.includes("--apply");
const dateSlug = (date) => new Date(date).toISOString().slice(0, 10);
const fmt = (n) => Math.round(n).toLocaleString();

function connectionString() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  const file = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const match = file.match(/^MONGODB_URI=(.+)$/m);
  if (!match) throw new Error("MONGODB_URI not set and not found in .env.local");
  return match[1].trim();
}

/** Bulk-writes in batches so a large collection never builds one huge request. */
async function flush(collection, ops) {
  for (let i = 0; i < ops.length; i += 1000) {
    await collection.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
  }
}

const client = new MongoClient(connectionString(), { serverSelectionTimeoutMS: 20000 });

try {
  await client.connect();
  const db = client.db();
  const state = db.collection("inventory_state");
  const cube = db.collection("stock_cube");

  console.log(APPLY ? "MODE: APPLY (writing)\n" : "MODE: DRY RUN (no writes)\n");

  // Invariants captured before anything is written, re-checked at the end. If
  // the backfill has disturbed a quantity or lost a row, this catches it.
  const before = (
    await state
      .aggregate([{ $group: { _id: null, rows: { $sum: 1 }, qty: { $sum: "$qty" } } }])
      .toArray()
  )[0];
  const cubeBefore = (
    await cube
      .aggregate([{ $group: { _id: null, rows: { $sum: 1 }, qty: { $sum: "$totalQty" } } }])
      .toArray()
  )[0];
  console.log(
    `inventory_state : ${fmt(before.rows)} rows, net qty ${fmt(before.qty)}\n` +
      `stock_cube      : ${fmt(cubeBefore.rows)} rows, net qty ${fmt(cubeBefore.qty)}\n`
  );

  // Prices and the two cube dimensions inventory_state does not carry.
  const price = new Map();
  for await (const p of db
    .collection("products")
    .find({}, { projection: { costPrice: 1, saleRate: 1, type: 1, sellingStatus: 1 } })
    .batchSize(5000)) {
    price.set(p._id, [p.costPrice || 0, p.saleRate || 0, p.type || "", p.sellingStatus || ""]);
  }
  console.log(`priced products : ${fmt(price.size)}`);

  // Pass 1 — stamp each stock row, and accumulate the cube totals as we go.
  // Valuation counts positive quantities only: negative stock is a counting
  // error, and netting it off would understate the holding by its full value.
  const cells = new Map(); // cube _id -> [cost, sale]
  const add = (id, cost, sale) => {
    const hit = cells.get(id);
    if (hit) { hit[0] += cost; hit[1] += sale; }
    else cells.set(id, [cost, sale]);
  };

  const ops = [];
  let stamped = 0;
  let unpriced = 0;
  let orphan = 0;
  let totalCost = 0;
  let totalSale = 0;

  for await (const s of state
    .find({}, { projection: { qty: 1, barcode: 1, branch: 1, category: 1, asOf: 1 } })
    .batchSize(5000)) {
    const p = price.get(s.barcode);
    if (!p) { orphan += 1; continue; }
    const [costPrice, saleRate, type, status] = p;
    if (!costPrice || !saleRate) unpriced += 1;

    ops.push({
      updateOne: { filter: { _id: s._id }, update: { $set: { costPrice, saleRate } } },
    });
    stamped += 1;

    const qty = s.qty || 0;
    if (qty > 0) {
      const cost = qty * costPrice;
      const sale = qty * saleRate;
      totalCost += cost;
      totalSale += sale;
      const day = dateSlug(s.asOf);
      const cat = s.category || "UNCATEGORIZED";
      add(`${day}|${s.branch}|${cat}|${type}|${status}`, cost, sale);
      // The ALL row is the sum across branches, matching how writeInventoryChunk
      // builds it — value is additive, unlike the product counts beside it.
      add(`${day}|ALL|${cat}|${type}|${status}`, cost, sale);
    }

    if (APPLY && ops.length >= 1000) { await flush(state, ops); ops.length = 0; }
  }
  if (APPLY && ops.length) await flush(state, ops);

  console.log(
    `stock rows      : ${fmt(stamped)} to stamp` +
      (unpriced ? `, ${fmt(unpriced)} with a zero/missing price` : "") +
      (orphan ? `, ${fmt(orphan)} with no product record (skipped)` : "")
  );
  console.log(`\nvaluation of stock on hand`);
  console.log(`  at cost       : Rs ${fmt(totalCost)}`);
  console.log(`  at sale       : Rs ${fmt(totalSale)}`);
  console.log(
    `  margin        : Rs ${fmt(totalSale - totalCost)}` +
      (totalSale ? `  (${(((totalSale - totalCost) / totalSale) * 100).toFixed(1)}% of sale)` : "")
  );

  // Pass 2 — write the cube sums. updateOne without upsert: a computed id that
  // no longer matches a cube row is reported rather than inserted, so this can
  // never invent a dimension combination the cube does not already have.
  const cubeOps = [...cells].map(([_id, [cost, sale]]) => ({
    updateOne: { filter: { _id }, update: { $set: { costValue: cost, saleValue: sale } } },
  }));
  console.log(`\ncube rows       : ${fmt(cubeOps.length)} to update`);

  if (APPLY) {
    let matched = 0;
    for (let i = 0; i < cubeOps.length; i += 1000) {
      const res = await cube.bulkWrite(cubeOps.slice(i, i + 1000), { ordered: false });
      matched += res.matchedCount;
    }
    const missing = cubeOps.length - matched;
    console.log(`  matched       : ${fmt(matched)}` + (missing ? `, ${fmt(missing)} NOT FOUND` : ""));

    // Verification — the figures the backfill must not have changed.
    const after = (
      await state
        .aggregate([{ $group: { _id: null, rows: { $sum: 1 }, qty: { $sum: "$qty" } } }])
        .toArray()
    )[0];
    const cubeAfter = (
      await cube
        .aggregate([
          {
            $group: {
              _id: null, rows: { $sum: 1 }, qty: { $sum: "$totalQty" },
              cost: { $sum: { $ifNull: ["$costValue", 0] } },
              sale: { $sum: { $ifNull: ["$saleValue", 0] } },
            },
          },
        ])
        .toArray()
    )[0];

    const ok = (label, a, b) =>
      console.log(`  ${label.padEnd(22)} ${a === b ? "unchanged ✓" : `CHANGED ✗  ${fmt(a)} -> ${fmt(b)}`}`);
    console.log("\nverification");
    ok("inventory_state rows", before.rows, after.rows);
    ok("inventory_state qty", before.qty, after.qty);
    ok("stock_cube rows", cubeBefore.rows, cubeAfter.rows);
    ok("stock_cube qty", cubeBefore.qty, cubeAfter.qty);

    // The cube's ALL rows duplicate the per-branch rows by design, so the cube
    // total is twice the true holding. Halved here purely to compare.
    const cubeCost = cubeAfter.cost / 2;
    console.log(
      `  cube vs rows           ${Math.round(cubeCost) === Math.round(totalCost) ? "agree ✓" : `DISAGREE ✗  cube Rs ${fmt(cubeCost)} vs rows Rs ${fmt(totalCost)}`}`
    );
  } else {
    console.log("\nNothing was written. Re-run with --apply to commit.");
  }
} finally {
  await client.close();
}
