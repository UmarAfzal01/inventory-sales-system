import mongoose from "mongoose";
import { COL, BRANCH_CODES, UNCATEGORIZED } from "@/lib/schema";
import { dateSlug } from "@/lib/ingest";
import {
  UNRESTRICTED,
  resolveAllowed,
  condition,
  isEmptyScope,
} from "@/lib/scope";

const db = () => mongoose.connection.db;
export const ALL = "ALL";

const chunk = async (items, size, fn) => {
  for (let i = 0; i < items.length; i += size) await fn(items.slice(i, i + size));
};

/**
 * Writes one parsed upload.
 *
 * Sales facts and cube rows are replaced per-day rather than incremented, so
 * re-uploading a day corrects it instead of doubling it. Inventory is a snapshot
 * of current state, so it replaces the branch's readings wholesale.
 */
export async function commit({ rows, fileType, batchId, dates }) {
  const database = db();

  // Is this inventory sheet newer than the readings we already hold?
  //
  // inventory_state is the CURRENT position, so a back-dated sheet must not
  // overwrite it — uploading Monday's count on Wednesday should not make the
  // dashboard think Monday's numbers are current. The snapshot still gets its
  // own historical cube; only the current position is protected.
  let isNewer = true;
  let currentAsOf = null;
  if (fileType === "inventory") {
    const held = await database
      .collection(COL.INVENTORY_STATE)
      .findOne({}, { projection: { asOf: 1 } });
    currentAsOf = held?.asOf ?? null;
    isNewer = !currentAsOf || dates[0] >= currentAsOf;
  }

  // --- catalogue -----------------------------------------------------------
  //
  // The INVENTORY sheet is the catalogue master. It is the full catalogue
  // (211k products against the sales sheet's 15k) and its attributes are
  // cleaner — the two sheets disagree about 159 products, and where they do,
  // the sales sheet is the unreliable one: it files some products under a
  // category that is actually a product name ("TINKLE LADY RAZOR 2PCS -68066").
  //
  // So a sales upload may INTRODUCE a product but never overwrite the
  // attributes of one that already exists. Without this, the last sheet
  // uploaded would decide every product's category, and upload order would
  // silently change how the dashboard groups things.
  //
  // stockAsOf moves forward only. A back-dated sheet must not drag it
  // backwards, or products would look less recently counted than they are.
  // Two derived fields ride along on the upsert that happens anyway, and
  // together they answer "what is sitting in stock and not selling?" without
  // scanning a million facts on every dashboard load:
  //
  //   inStock     - set from the inventory sheet, which lists the whole
  //                 catalogue, so it is refreshed wholesale each snapshot.
  //   lastSoldAt  - the newest day this product sold, written with $max so a
  //                 back-dated sheet can never drag it backwards.
  //
  // Deriving dead stock live costs 5.1s at the top level; reading these costs
  // 0.24s, and agrees exactly.
  const products = new Map();
  const lastSold = new Map();
  for (const r of rows) {
    products.set(r.barcode, {
      ...r.product,
      ...(fileType === "inventory" && isNewer
        ? { stockAsOf: r.date, inStock: r.cells.some((c) => c.qty > 0) }
        : {}),
    });
    if (fileType === "sale" && r.cells.length) {
      const prev = lastSold.get(r.barcode);
      if (!prev || r.date > prev) lastSold.set(r.barcode, r.date);
    }
  }
  await chunk([...products.entries()], 1000, (batch) =>
    database.collection(COL.PRODUCTS).bulkWrite(
      batch.map(([barcode, p]) => ({
        updateOne: {
          filter: { _id: barcode },
          update: {
            ...(fileType === "inventory" ? { $set: p } : { $setOnInsert: p }),
            ...(lastSold.has(barcode) ? { $max: { lastSoldAt: lastSold.get(barcode) } } : {}),
          },
          upsert: true,
        },
      })),
      { ordered: false }
    )
  );

  if (fileType === "sale") {
    // The rule above says the catalogue wins over the sales sheet. The facts
    // have to be told, or they carry the sheet's category while the cube reads
    // the catalogue's, and the two disagree: the sales sheet calls a category
    // FRESH PRODUCE where the inventory sheet splits it into F&V and MEAT, so
    // level 1 and level 2 reported the same units under different names.
    const catalogue = await loadCatalogueCategories(database, [...products.keys()]);
    await withoutSecondaryIndexes(database, [COL.SALES_FACTS, COL.DAILY_CUBE], async () => {
      await commitSales({ database, rows, batchId, dates, catalogue });
      // Only the uploaded days are re-aggregated. Rebuilding everything made an
      // upload's cost grow with total history — quadratic across a backfill.
      await rebuildDailyCube(database, dates);
    });
    return { products: products.size };
  }

  const written = await withoutSecondaryIndexes(
    database,
    [COL.INVENTORY_STATE, COL.STOCK_CUBE],
    async () => {
      const n = await commitInventory({ database, rows, batchId, dates, isNewer });

      // The stock cube is built from the SHEET, not from inventory_state. A
      // back-dated sheet leaves inventory_state alone, so reading it would file
      // today's numbers under an old date. Building from the sheet also makes the
      // cube reflect exactly what that snapshot covered.
      await buildStockCubeFromRows({ database, rows, date: dates[0] });
      return n;
    }
  );

  return {
    products: products.size,
    currentPositionUpdated: isNewer,
    heldAsOf: currentAsOf ? dateSlug(currentAsOf) : null,
    readings: written,
  };
}

/**
 * Runs a bulk load with the collections' secondary indexes removed, rebuilding
 * them once the writes are done.
 *
 * An index maintained row-by-row through a bulk insert ends up roughly 5x
 * larger than the same index built in one pass afterwards — 121MB against 29MB
 * for 23 days of sales facts. Compacting after the fact reclaims that, but the
 * bloat still has to EXIST first, and on a 512MB tier that peak is what
 * exhausts the quota: the load that failed had already written every row and
 * died holding 121MB of index it was about to shrink to 29MB.
 *
 * Dropping first means the peak never contains it. Unique indexes stay put —
 * dropping one, even briefly, would let a concurrent upload past the batch
 * lock, and they are tiny anyway.
 */
async function withoutSecondaryIndexes(database, names, work) {
  const dropped = [];
  for (const name of names) {
    const indexes = await database.collection(name).indexes().catch(() => []);
    for (const index of indexes) {
      if (index.name === "_id_" || index.unique) continue;
      await database.collection(name).dropIndex(index.name);
      dropped.push({ name, key: index.key, indexName: index.name });
    }
  }
  try {
    return await work();
  } finally {
    // Rebuilt even if the load threw: a half-written collection with its
    // indexes missing would leave every dashboard query on a collection scan.
    for (const d of dropped) {
      await database
        .collection(d.name)
        .createIndex(d.key, { name: d.indexName })
        .catch(() => {});
    }
  }
}

/**
 * The catalogue's category, sub-category and sale rate for the given barcodes.
 *
 * Read back after the upsert, so it reflects both products that already existed
 * and ones this sheet just introduced. Queried in chunks rather than one $in of
 * every barcode — a sales sheet carries ~190k of them, which is a needlessly
 * large query document.
 */
async function loadCatalogueCategories(database, barcodes) {
  const out = new Map();
  for (let i = 0; i < barcodes.length; i += 5000) {
    const slice = barcodes.slice(i, i + 5000);
    const found = await database
      .collection(COL.PRODUCTS)
      .find({ _id: { $in: slice } }, { projection: { category: 1, subCategory: 1, saleRate: 1 } })
      .toArray();
    for (const p of found) out.set(p._id, p);
  }
  return out;
}

async function commitSales({ database, rows, batchId, dates, catalogue }) {
  await database.collection(COL.SALES_FACTS).deleteMany({ date: { $in: dates } });

  // A sheet may list the same product/branch/day on more than one line. Summing
  // those into one fact is the correct reading; inserting both would collide on
  // the natural key and abort the whole upload.
  const byKey = new Map();
  for (const r of rows) {
    for (const c of r.cells) {
      const _id = `${dateSlug(r.date)}|${c.branch}|${r.barcode}`;
      const existing = byKey.get(_id);
      if (existing) existing.qty += c.qty;
      else
        byKey.set(_id, {
          _id,
          date: r.date,
          branch: c.branch,
          barcode: r.barcode,
          qty: c.qty,
          // Category is denormalised onto the fact so drill-down never needs a
          // $lookup. Joining 1.7M facts against 194k products took 51s; matching
          // a stored field takes 0.14s. It also makes product-level listing
          // possible at all — cubes aggregate the product away.
          //
          // Taken from the catalogue, falling back to the sheet only for a
          // product the catalogue somehow lacks. The sheet's own value is the
          // unreliable one — see the catalogue-master note in commit().
          category: catalogue.get(r.barcode)?.category || r.product.category || UNCATEGORIZED,
          subCategory: catalogue.get(r.barcode)?.subCategory ?? (r.product.subCategory || ""),
          // The sale rate at the moment this sheet was loaded, frozen onto the
          // fact. It lives only in the INVENTORY sheet, so the catalogue is the
          // only source; reading it live instead would silently rewrite every
          // historical revenue figure the next time a price changed.
          rate: catalogue.get(r.barcode)?.saleRate ?? r.product.saleRate ?? 0,
          batchId,
        });
    }
  }
  const facts = [...byKey.values()];
  await chunk(facts, 1000, (batch) =>
    database.collection(COL.SALES_FACTS).insertMany(batch, { ordered: false })
  );

  return facts.length;
}

/**
 * Writes an inventory snapshot.
 *
 * inventory_state holds only NON-ZERO readings: a full snapshot is 2.33M cells
 * of which ~78% are zero, and storing them costs ~250MB plus indexes. Zero is
 * encoded by absence and counted from coverage.
 *
 * When `isNewer` is false the sheet is older than the readings already held, so
 * the current position is left untouched — only the historical record is written.
 */
async function commitInventory({ database, rows, batchId, dates, isNewer }) {
  const asOf = dates[0];
  const touched = new Set();
  const seen = new Map();
  const coverage = new Map();

  for (const r of rows) {
    for (const c of r.cells) {
      touched.add(c.branch);
      const _id = `${c.branch}|${r.barcode}`;
      // A repeated product/branch line is a later reading of the same thing, so
      // the last one wins rather than colliding on the natural key.
      if (!seen.has(_id)) coverage.set(c.branch, (coverage.get(c.branch) || 0) + 1);
      seen.set(_id, {
        qty: c.qty,
        category: r.product.category || UNCATEGORIZED,
        subCategory: r.product.subCategory || "",
      });
    }
  }

  // Coverage is recorded per (date, branch). Zero stock is derived as
  // `coveredProducts - nonZeroReadings`, so every historical date needs its own
  // coverage figure or that subtraction is wrong for past dates.
  await database.collection(COL.COVERAGE).bulkWrite(
    [...coverage.entries()].map(([branch, productCount]) => ({
      updateOne: {
        filter: { _id: `${dateSlug(asOf)}|${branch}` },
        update: { $set: { date: asOf, branch, productCount, batchId } },
        upsert: true,
      },
    }))
  );

  if (!isNewer) return 0;

  const docs = [];
  for (const [_id, entry] of seen) {
    if (entry.qty === 0) continue; // absence encodes zero
    const [branch, ...rest] = _id.split("|");
    docs.push({
      _id,
      branch,
      barcode: rest.join("|"),
      qty: entry.qty,
      category: entry.category,
      subCategory: entry.subCategory,
      asOf,
      batchId,
    });
  }

  await database.collection(COL.INVENTORY_STATE).deleteMany({ branch: { $in: [...touched] } });
  await chunk(docs, 1000, (batch) =>
    database.collection(COL.INVENTORY_STATE).insertMany(batch, { ordered: false })
  );

  return docs.length;
}

/**
 * Builds stock_cube for one snapshot date directly from the uploaded rows.
 *
 * Everything needed is in the sheet: the products it covered, their category /
 * type / selling status, and each branch reading. So this needs no database
 * reads, and — critically — it stays correct for a back-dated sheet, which
 * deliberately does not update inventory_state.
 *
 * zeroStock is DERIVED, not stored: a product the snapshot covered with no
 * non-zero reading at a branch read zero there.
 */
export async function buildStockCubeFromRows({ database, rows, date }) {
  const builtAt = new Date();
  const day = dateSlug(date);
  const key = (b, c, t, s) => `${b}|${c}|${t}|${s}`;

  // Per (category, type, status): how many products the snapshot covered.
  // Per (branch, category, type, status): the non-zero readings.
  const dims = new Map();
  const cells = new Map();
  const branches = new Set();
  // Per product, across branches — needed for the ALL rows, where a product
  // counts once no matter how many branches it is out of stock in.
  const perProduct = new Map();

  // A sheet can list the same barcode more than once — yours has 19 such rows.
  // Collapse them first, last occurrence winning, exactly as commitInventory
  // does when writing inventory_state. Counting the rows directly instead
  // double-counted those products and inflated every branch total.
  const unique = new Map();
  for (const r of rows) unique.set(r.barcode, r);

  for (const r of unique.values()) {
    const c = r.product.category || UNCATEGORIZED;
    const t = r.product.type || "";
    const st = r.product.sellingStatus || "";
    const dk = `${c}|${t}|${st}`;
    dims.set(dk, (dims.get(dk) || 0) + 1);

    let agg = perProduct.get(r.barcode);
    if (!agg) { agg = { dk, nonZero: 0, negative: 0, total: 0 }; perProduct.set(r.barcode, agg); }

    for (const cell of r.cells) {
      branches.add(cell.branch);
      if (cell.qty === 0) continue;
      const ck = key(cell.branch, c, t, st);
      let hit = cells.get(ck);
      if (!hit) { hit = { nonZero: 0, negative: 0, total: 0 }; cells.set(ck, hit); }
      hit.nonZero += 1;
      hit.total += cell.qty;
      if (cell.qty < 0) hit.negative += 1;

      agg.nonZero += 1;
      agg.total += cell.qty;
      if (cell.qty < 0) agg.negative += 1;
    }
  }

  const branchList = [...branches];
  const docs = [];

  for (const branch of branchList) {
    for (const [dk, productCount] of dims) {
      const [c, t, st] = dk.split("|");
      const hit = cells.get(key(branch, c, t, st));
      docs.push({
        _id: `${day}|${key(branch, c, t, st)}`,
        date, branch, category: c, type: t, sellingStatus: st,
        productCount,
        totalQty: hit?.total ?? 0,
        negativeStockCount: hit?.negative ?? 0,
        zeroStockCount: Math.max(0, productCount - (hit?.nonZero ?? 0)),
        builtAt,
      });
    }
  }

  // ALL rows: a product out of stock at three branches is one zero-stock
  // product, not three, so these are counted per product rather than summed.
  const allAgg = new Map();
  for (const agg of perProduct.values()) {
    let a = allAgg.get(agg.dk);
    if (!a) { a = { productCount: 0, total: 0, negative: 0, zero: 0 }; allAgg.set(agg.dk, a); }
    a.productCount += 1;
    a.total += agg.total;
    if (agg.negative > 0) a.negative += 1;
    if (agg.nonZero < branchList.length) a.zero += 1;
  }
  for (const [dk, a] of allAgg) {
    const [c, t, st] = dk.split("|");
    docs.push({
      _id: `${day}|${key(ALL, c, t, st)}`,
      date, branch: ALL, category: c, type: t, sellingStatus: st,
      productCount: a.productCount,
      totalQty: a.total,
      negativeStockCount: a.negative,
      zeroStockCount: a.zero,
      builtAt,
    });
  }

  await chunk(docs, 1000, (batch) =>
    database.collection(COL.STOCK_CUBE).bulkWrite(
      batch.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })),
      { ordered: false }
    )
  );

  await database.collection(COL.STOCK_CUBE).deleteMany({ date, builtAt: { $lt: builtAt } });
  return docs.length;
}

/**
 * Re-aggregates sales_facts into daily_cube for the given dates only.
 *
 * Cube rows carry a deterministic _id built from their dimensions, so a rebuild
 * REPLACES a date's rows in place via $merge. An earlier version deleted the
 * whole collection first and rebuilt under a new "build id"; that made a
 * dashboard loaded mid-rebuild read an empty cube and report zeros as real, and
 * it re-read all history on every upload.
 *
 * The stale sweep afterwards removes rows for dimension combinations that
 * existed on a previous build of this date but no longer do — e.g. a day
 * re-uploaded with a product removed.
 */
export async function rebuildDailyCube(database, dates) {
  if (!dates?.length) return;
  const builtAt = new Date();

  await database
    .collection(COL.SALES_FACTS)
    .aggregate(
      [
        { $match: { date: { $in: dates } } },
        {
          $lookup: {
            from: COL.PRODUCTS,
            localField: "barcode",
            foreignField: "_id",
            as: "p",
          },
        },
        { $unwind: { path: "$p", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: {
              d: "$date",
              b: "$branch",
              // The fact's own category, not the looked-up one. Both now come
              // from the catalogue, and grouping on the stored field is what
              // keeps level 1 agreeing with levels 2 and 3, which read the
              // facts directly. The lookup survives only for type and selling
              // status, which are not denormalised onto the fact.
              c: { $ifNull: ["$category", UNCATEGORIZED] },
              t: { $ifNull: ["$p.type", ""] },
              s: { $ifNull: ["$p.sellingStatus", ""] },
            },
            sale: { $sum: "$qty" },
            pos: { $sum: { $cond: [{ $gt: ["$qty", 0] }, "$qty", 0] } },
            neg: { $sum: { $cond: [{ $lt: ["$qty", 0] }, "$qty", 0] } },
            amount: { $sum: { $multiply: ["$qty", { $ifNull: ["$rate", 0] }] } },
            // A plain count, not $addToSet. sales_facts holds one row per
            // (date, branch, barcode), and the group key includes date and
            // branch — so each barcode contributes exactly one document and the
            // count IS the distinct product count. Accumulating a barcode set
            // per group instead blew the 100MB $group limit once subCategory
            // multiplied the number of groups, and allowDiskUse is unavailable
            // on the current Atlas tier.
            productCount: { $sum: 1 },
          },
        },
        {
          $project: {
            _id: {
              $concat: [
                { $dateToString: { date: "$_id.d", format: "%Y-%m-%d" } }, "|",
                "$_id.b", "|", "$_id.c", "|", "$_id.t", "|", "$_id.s",
              ],
            },
            date: "$_id.d",
            branch: "$_id.b",
            category: "$_id.c",
            type: "$_id.t",
            sellingStatus: "$_id.s",
            sale: 1, pos: 1, neg: 1, amount: 1,
            productCount: 1,
            builtAt: { $literal: builtAt },
          },
        },
        { $merge: { into: COL.DAILY_CUBE, whenMatched: "replace", whenNotMatched: "insert" } },
      ],
      { allowDiskUse: false }
    )
    .toArray();

  await database
    .collection(COL.DAILY_CUBE)
    .deleteMany({ date: { $in: dates }, builtAt: { $lt: builtAt } });
}

/**
 * Rebuilds every non-unique secondary index, reclaiming insert-time bloat.
 *
 * An index filled row-by-row during a bulk insert ends up roughly 5x larger
 * than the same index built in one pass afterwards: 44.5MB -> 8.9MB on an
 * inventory load, 70.7MB -> 29MB on 23 days of sales. On a 512MB tier that is
 * the difference between holding three weeks of history and holding five.
 *
 * Unique indexes are left alone — dropping one, even briefly, would open a
 * window where a concurrent upload could bypass the batch lock.
 */
export async function compactIndexes(database, collections) {
  let reclaimed = 0;
  for (const name of collections) {
    const stats = await database.command({ collStats: name }).catch(() => null);
    if (!stats) continue;
    const indexes = await database.collection(name).indexes();
    for (const index of indexes) {
      if (index.name === "_id_" || index.unique) continue;
      const before = stats.indexSizes[index.name] || 0;
      try {
        await database.collection(name).dropIndex(index.name);
        await database.collection(name).createIndex(index.key, { name: index.name });
      } catch {
        // A failed rebuild leaves the index missing; the next upload's
        // ensureSchema({ force: true }) puts it back. Not worth failing an
        // otherwise-good commit over.
        continue;
      }
      const after = (await database.command({ collStats: name })).indexSizes[index.name] || 0;
      reclaimed += before - after;
    }
  }
  return reclaimed;
}

/** Filter options and the available date range, recomputed after each upload. */
export async function rebuildMeta() {
  const database = db();
  const [types, statuses, categories, range, snapshots] = await Promise.all([
    database.collection(COL.PRODUCTS).distinct("type"),
    database.collection(COL.PRODUCTS).distinct("sellingStatus"),
    database.collection(COL.PRODUCTS).distinct("category"),
    database
      .collection(COL.SALES_FACTS)
      .aggregate([{ $group: { _id: null, min: { $min: "$date" }, max: { $max: "$date" } } }])
      .toArray(),
    database.collection(COL.STOCK_CUBE).distinct("date"),
  ]);

  // The selectable range has to span BOTH kinds of data. Bounded by sales
  // alone, a stock snapshot taken after the last sales day sits outside every
  // preset, so "last 30 days" resolved to no snapshot and reported stock as
  // unknown — while the snapshot sat there, four days later.
  const salesMin = range[0]?.min ?? null;
  const salesMax = range[0]?.max ?? null;
  const stockMin = snapshots.length ? new Date(Math.min(...snapshots)) : null;
  const stockMax = snapshots.length ? new Date(Math.max(...snapshots)) : null;
  const earliest = [salesMin, stockMin].filter(Boolean);
  const latest = [salesMax, stockMax].filter(Boolean);

  const doc = {
    branches: BRANCH_CODES,
    types: types.filter(Boolean).sort(),
    statuses: statuses.filter(Boolean).sort(),
    categories: categories.filter(Boolean).sort(),
    minDate: earliest.length ? new Date(Math.min(...earliest)) : null,
    maxDate: latest.length ? new Date(Math.max(...latest)) : null,
    // Kept separately: whether dead stock can take its cheap path depends on
    // the last SALE, not on the last snapshot.
    maxSalesDate: salesMax,
    totalProducts: await database.collection(COL.PRODUCTS).estimatedDocumentCount(),
    builtAt: new Date(),
  };

  // $set, not replaceOne — this document accumulates fields written elsewhere,
  // and replacing it wholesale has silently wiped one of them before.
  await database
    .collection(COL.META)
    .updateOne({ _id: "filters" }, { $set: doc }, { upsert: true });

  return doc;
}

/**
 * Which category or sub-category rows a clicked metric card should leave
 * visible. Returns a pass-everything predicate when no card is active.
 *
 * A null count means no stock snapshot covers the range — unknown, not zero —
 * so the stock metrics match nothing rather than claiming every product
 * qualifies.
 */
function rowMatchesMetric(metric) {
  switch (metric) {
    case "totalSales":
      return (r) => r.totalSales !== 0;
    case "positiveSales":
      return (r) => r.positiveSales > 0;
    case "negativeSales":
      return (r) => r.negativeSales < 0;
    case "negativeStock":
      return (r) => (r.negativeStockCount ?? 0) > 0;
    case "zeroStock":
      return (r) => (r.zeroStockCount ?? 0) > 0;
    case "zeroSales":
      return (r) => (r.zeroSalesCount ?? 0) > 0;
    default:
      return () => true;
  }
}

/**
 * The same rule applied to a single product at level 3.
 *
 * `branchesCovered` is how many branches the snapshot reached, so "zero stock"
 * means the same thing here as it does on the cards above: not stocked at every
 * covered branch, rather than merely absent from one.
 */
function productMatchesMetric(metric, { branchesCovered, stockKnown, inCatalogue }) {
  switch (metric) {
    case "totalSales":
      return (p) => p.sale !== 0;
    case "positiveSales":
      return (p) => p.pos > 0;
    case "negativeSales":
      return (p) => p.neg < 0;
    case "negativeStock":
      return (p) => stockKnown && Object.values(p.branchStock).some((q) => q < 0);
    case "zeroStock":
      // inCatalogue mirrors the headline count, which skips products that sold
      // but no stock sheet covers. Without it the filtered list came back 537
      // long while the card it was filtering by read 512.
      return (p) =>
        stockKnown &&
        inCatalogue(p.barcode) &&
        Object.keys(p.branchStock).length < branchesCovered;
    case "zeroSales":
      // Dead stock: it is on a shelf somewhere and moved nothing.
      return (p) => stockKnown && p.stock > 0 && p.sale === 0;
    default:
      return () => true;
  }
}

/**
 * Products that are in stock but sold nothing in the range — dead stock —
 * counted per category, or per sub-category once a category is chosen.
 *
 * Two ways to get there:
 *
 * FAST (0.24s) reads the `lastSoldAt` stamped on each product at upload. It is
 * only valid when the range runs to the end of the data: "last sold before
 * `from`" means "sold nothing since `from`", which equals "sold nothing in
 * [from, to]" only when `to` is at or past the final sale. Every preset is a
 * trailing window, so this covers the normal case.
 *
 * EXACT (0.5-5.1s) unions stock against facts and is used when `to` stops
 * short, where a stored last-sale date genuinely cannot answer the question.
 */
async function readDeadStock({
  database, branch, type, sellingStatus, from, to, category, stockDate, maxSalesDate,
  scope = UNRESTRICTED,
}) {
  const out = new Map();
  // No snapshot covers the range, so "in stock" is unknown, not false.
  if (!stockDate) return out;

  const trailing = !to || (maxSalesDate && to >= maxSalesDate);
  const groupField = category ? "$subCategory" : "$category";

  // The cheap path needs the whole estate; a branch-scoped user has to be
  // counted per branch, so it falls through to the exact union below.
  if (branch === ALL && trailing && !scope.branches) {
    const match = { inStock: true };
    if (category) match.category = category;
    if (type !== ALL) match.type = type;
    if (sellingStatus !== ALL) match.sellingStatus = sellingStatus;
    if (scope.categories && !category) match.category = { $in: scope.categories };
    if (scope.subCategories) match.subCategory = { $in: scope.subCategories };
    if (scope.products) match._id = { $in: scope.products };
    // With no lower bound the whole history is in range, so dead stock means
    // never sold at all. $lt against null would misbehave — undefined sorts
    // below null in BSON — so the two cases are kept apart.
    match.$or = from ? [{ lastSoldAt: null }, { lastSoldAt: { $lt: from } }] : [{ lastSoldAt: null }];

    const rows = await database
      .collection(COL.PRODUCTS)
      .aggregate([{ $match: match }, { $group: { _id: groupField, n: { $sum: 1 } } }])
      .toArray();
    for (const r of rows) out.set(r._id || UNCATEGORIZED, r.n);
    return out;
  }

  const dBranch = condition(resolveAllowed(branch, scope.branches));
  const dCategory = condition(resolveAllowed(category ?? ALL, scope.categories));
  const dSub = condition(scope.subCategories ? [...scope.subCategories] : null);
  const dProduct = condition(scope.products ? [...scope.products] : null);

  const stockMatch = { asOf: stockDate, qty: { $gt: 0 } };
  if (dBranch !== undefined) stockMatch.branch = dBranch;
  if (dCategory !== undefined) stockMatch.category = dCategory;
  if (dSub !== undefined) stockMatch.subCategory = dSub;
  if (dProduct !== undefined) stockMatch.barcode = dProduct;
  const saleMatch = {};
  if (dBranch !== undefined) saleMatch.branch = dBranch;
  if (dCategory !== undefined) saleMatch.category = dCategory;
  if (dSub !== undefined) saleMatch.subCategory = dSub;
  if (dProduct !== undefined) saleMatch.barcode = dProduct;
  if (from || to) {
    saleMatch.date = {};
    if (from) saleMatch.date.$gte = from;
    if (to) saleMatch.date.$lte = to;
  }

  // type and selling status live on products, not on either collection here.
  if (type !== ALL || sellingStatus !== ALL) {
    const q = {};
    if (category) q.category = category;
    if (type !== ALL) q.type = type;
    if (sellingStatus !== ALL) q.sellingStatus = sellingStatus;
    const ids = (await database.collection(COL.PRODUCTS).find(q, { projection: { _id: 1 } }).toArray())
      .map((x) => x._id);
    if (!ids.length) return out;
    stockMatch.barcode = { $in: ids };
    saleMatch.barcode = { $in: ids };
  }

  // k=1 marks a stock row, k=0 a sale. $max picks up any stock row, $min any
  // sale row, so stock=1 with sale=1 means stocked and never sold in range.
  const rows = await database
    .collection(COL.INVENTORY_STATE)
    .aggregate([
      { $match: stockMatch },
      { $project: { _id: 0, g: groupField, b: "$barcode", k: { $literal: 1 } } },
      {
        $unionWith: {
          coll: COL.SALES_FACTS,
          pipeline: [
            { $match: saleMatch },
            { $project: { _id: 0, g: groupField, b: "$barcode", k: { $literal: 0 } } },
          ],
        },
      },
      { $group: { _id: { g: "$g", b: "$b" }, stock: { $max: "$k" }, sale: { $min: "$k" } } },
      { $match: { stock: 1, sale: 1 } },
      { $group: { _id: "$_id.g", n: { $sum: 1 } } },
    ])
    .toArray();
  for (const r of rows) out.set(r._id || UNCATEGORIZED, r.n);
  return out;
}

/** Every snapshot date held in stock_cube, oldest first. */
export async function snapshotDates(database) {
  const dates = await database.collection(COL.STOCK_CUBE).distinct("date");
  return dates.sort((a, b) => a - b);
}

/**
 * The snapshot a stock figure should come from for a given end date: the newest
 * one at or before it, or the newest overall when no end date is given.
 */
export async function resolveStockDate(database, to) {
  const match = to ? { date: { $lte: to } } : {};
  const row = await database
    .collection(COL.STOCK_CUBE)
    .find(match, { projection: { date: 1 } })
    .sort({ date: -1 })
    .limit(1)
    .next();
  return row?.date ?? null;
}

/**
 * Level 3 of the drill-down: the products inside one sub-category.
 *
 * Reads the FACTS, not the cubes — a cube row is a total across many products,
 * so the product is aggregated away and no cube can answer this. Both fact
 * collections carry `category`/`subCategory` denormalised precisely so this
 * needs no $lookup: joining 1.7M facts against 194k products took 51s, whereas
 * matching a stored field takes 0.14s.
 *
 * Sales are summed over the date range; stock is the position at the resolved
 * snapshot — the same distinction the rest of the dashboard makes.
 */
export async function readProducts({
  branch = ALL,
  type = ALL,
  sellingStatus = ALL,
  from = null,
  to = null,
  category,
  subCategory,
  q = "",
  page = 1,
  pageSize = 50,
  metricFilter = null,
  scope = UNRESTRICTED,
  // Revenue is admin-only, so it is not computed at all for anyone else rather
  // than computed and then hidden — a field omitted from the response cannot
  // leak through the API.
  includeAmount = false,
} = {}) {
  const database = db();
  // category / subCategory are optional. With neither, this is a global product
  // search across the catalogue, still scoped by branch, type, status and dates.
  const scoped = Boolean(category);
  const sub = subCategory ?? null;

  // type / sellingStatus are not on the facts. Resolving the matching barcodes
  // first keeps the facts lean — a sub-category holds at most a few thousand
  // products, so the $in stays small.
  let barcodeFilter = null;
  if (type !== ALL || sellingStatus !== ALL) {
    const q = {};
    if (scoped) q.category = category;
    if (sub !== null) q.subCategory = sub;
    if (type !== ALL) q.type = type;
    if (sellingStatus !== ALL) q.sellingStatus = sellingStatus;
    if (scope.products) q._id = { $in: scope.products };
    if (scope.categories && !scoped) q.category = { $in: scope.categories };
    if (scope.subCategories && sub === null) q.subCategory = { $in: scope.subCategories };
    const ids = await database
      .collection(COL.PRODUCTS)
      .find(q, { projection: { _id: 1 } })
      .toArray();
    barcodeFilter = ids.map((x) => x._id);
    if (!barcodeFilter.length) {
      return { products: [], total: 0, page, pageSize, stockDate: null };
    }
  }

  // Scope resolved the same way as level 1/2: an empty list means the request
  // fell outside what this account may see, so nothing is returned.
  const pBranchIn = resolveAllowed(branch, scope.branches);
  const pCategoryIn = resolveAllowed(scoped ? category : ALL, scope.categories);
  const pSubIn = resolveAllowed(sub !== null ? sub : ALL, scope.subCategories);
  const pOutOfScope = isEmptyScope(pBranchIn, pCategoryIn, pSubIn);
  const pBranch = condition(pBranchIn);
  const pCategory = condition(pCategoryIn);
  const pSub = condition(pSubIn);
  const pProduct = condition(scope.products ? [...scope.products] : null);

  const salesMatch = {};
  if (pCategory !== undefined) salesMatch.category = pCategory;
  if (pSub !== undefined) salesMatch.subCategory = pSub;
  if (pBranch !== undefined) salesMatch.branch = pBranch;
  if (pProduct !== undefined) salesMatch.barcode = pProduct;
  if (barcodeFilter) salesMatch.barcode = { $in: barcodeFilter };
  if (from || to) {
    salesMatch.date = {};
    if (from) salesMatch.date.$gte = from;
    if (to) salesMatch.date.$lte = to;
  }

  // Stock must answer to the date range the same way level 1 does.
  //
  // inventory_state holds exactly one snapshot — the latest, by the back-date
  // rule — and every row carries the `asOf` it came from. Matching on that
  // makes the three levels agree: if the newest snapshot at or before `to` is
  // not the one held, this level has no per-product stock for that date and
  // says so, rather than quietly showing today's count under an older date.
  const stockDate = await resolveStockDate(database, to);
  const stockMatch = { asOf: stockDate };
  if (pCategory !== undefined) stockMatch.category = pCategory;
  if (pSub !== undefined) stockMatch.subCategory = pSub;
  if (pBranch !== undefined) stockMatch.branch = pBranch;
  if (pProduct !== undefined) stockMatch.barcode = pProduct;
  if (barcodeFilter) stockMatch.barcode = { $in: barcodeFilter };

  const catalogueQuery = { stockAsOf: { $ne: null } };
  if (pCategory !== undefined) catalogueQuery.category = pCategory;
  if (pSub !== undefined) catalogueQuery.subCategory = pSub;
  if (pProduct !== undefined) catalogueQuery._id = pProduct;
  if (type !== ALL) catalogueQuery.type = type;
  if (sellingStatus !== ALL) catalogueQuery.sellingStatus = sellingStatus;

  // An unscoped search would otherwise pull all 194k products into memory. The
  // term narrows it in the database instead; a barcode-looking term matches by
  // prefix, anything else by name.
  const searchTerm = String(q || "").trim();
  if (!scoped) {
    if (!searchTerm) {
      return { products: [], total: 0, page, pageSize, stats: null, branches: [], stockDate: null, unfilteredTotal: 0 };
    }
    catalogueQuery.$or = [
      { _id: { $regex: "^" + searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") } },
      { articleName: { $regex: searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
    ];
  }

  if (pOutOfScope) {
    return { products: [], total: 0, page, pageSize, stats: null, branches: [], stockDate: null, unfilteredTotal: 0 };
  }

  const catalogue = await database
    .collection(COL.PRODUCTS)
    .find(catalogueQuery, { projection: { articleName: 1, type: 1, sellingStatus: 1 } })
    .limit(scoped ? 0 : 500)
    .toArray();

  // For a global search the facts must be restricted to what was found, or the
  // aggregations below would scan every fact in the database.
  if (!scoped) {
    const found = catalogue.map((p) => p._id);
    salesMatch.barcode = { $in: found };
    stockMatch.barcode = { $in: found };
  }


  const [sales, stock, branchCount] = await Promise.all([
    database
      .collection(COL.SALES_FACTS)
      .aggregate([
        { $match: salesMatch },
        // Grouped by branch as well, so each product can show where it sold.
        {
          $group: {
            _id: { b: "$barcode", br: "$branch" },
            sale: { $sum: "$qty" },
            pos: { $sum: { $cond: [{ $gt: ["$qty", 0] }, "$qty", 0] } },
            neg: { $sum: { $cond: [{ $lt: ["$qty", 0] }, "$qty", 0] } },
            ...(includeAmount
              ? { amount: { $sum: { $multiply: ["$qty", { $ifNull: ["$rate", 0] }] } } }
              : {}),
          },
        },
      ])
      .toArray(),
    // Kept per branch, not summed, so each product can show where its stock is.
    // Skipped outright when no snapshot covers the range — an $in over every
    // barcode is not worth issuing to match nothing.
    stockDate
      ? database
          .collection(COL.INVENTORY_STATE)
          .aggregate([
            { $match: stockMatch },
            { $group: { _id: { b: "$barcode", br: "$branch" }, qty: { $sum: "$qty" } } },
          ])
          .toArray()
      : Promise.resolve([]),
    database
      .collection(COL.COVERAGE)
      .distinct("branch")
      .then((all) => (scope.branches ? all.filter((b) => scope.branches.includes(b)) : all)),
  ]);

  // Seed from the catalogue, not from the facts.
  //
  // A product with no sales AND no stock anywhere has no fact rows at all, so
  // building the list from facts silently omitted it — level 3 showed 879
  // products where level 2 counted 1,543. Those are exactly the out-of-stock,
  // non-selling lines someone drilling in most wants to see.
  const merged = new Map();
  const slot = (barcode) => {
    if (!merged.has(barcode)) {
      merged.set(barcode, {
        barcode, sale: 0, pos: 0, neg: 0, amount: 0, stock: 0,
        branchStock: {}, branchSales: {}, branchAmount: {},
      });
    }
    return merged.get(barcode);
  };
  const meta = new Map();
  for (const p of catalogue) {
    slot(p._id);
    meta.set(p._id, p);
  }
  for (const r of sales) {
    const t = slot(r._id.b);
    t.branchSales[r._id.br] = r.sale;
    t.sale += r.sale;
    t.pos += r.pos;
    t.neg += r.neg;
    if (includeAmount) {
      t.amount += r.amount ?? 0;
      t.branchAmount[r._id.br] = r.amount ?? 0;
    }
  }
  for (const r of stock) {
    const t = slot(r._id.b);
    t.branchStock[r._id.br] = r.qty;
    t.stock += r.qty;
  }

  // Best sellers first; barcode breaks ties so paging is stable.
  const all = [...merged.values()].sort(
    (a, b) =>
      b.sale - a.sale ||
      b.stock - a.stock ||
      (byIdName(a.barcode) || "").localeCompare(byIdName(b.barcode) || "") ||
      a.barcode.localeCompare(b.barcode)
  );
  function byIdName(bc) { return meta.get(bc)?.articleName; }
  const term = String(q || "").trim().toLowerCase();
  const searched = term
    ? all.filter(
        (p) =>
          p.barcode.toLowerCase().includes(term) ||
          (meta.get(p.barcode)?.articleName || "").toLowerCase().includes(term)
      )
    : all;

  // Applied before paging, so page 1 of a filtered list is full rather than
  // whatever survived filtering the first fifty rows.
  const visible = searched.filter(
    productMatchesMetric(metricFilter, {
      branchesCovered: branch === ALL ? (branchCount.length || BRANCH_CODES.length) : 1,
      stockKnown: Boolean(stockDate),
      inCatalogue: (barcode) => meta.has(barcode),
    })
  );

  const total = visible.length;

  // Headline figures cover EVERY matching product, not just the visible page —
  // otherwise the metric cards would change as you turned the page.
  const branchesCovered = branch === ALL ? (branchCount.length || BRANCH_CODES.length) : 1;
  // Products that sold but are absent from the inventory sheet still appear in
  // the list — they are real sales — but they are excluded from the counts, so
  // the headline figures keep agreeing with level 2, which counts only products
  // a stock snapshot covered.
  const stats = all.reduce(
    (a, p) => {
      const inCatalogue = meta.has(p.barcode);
      const stocked = Object.keys(p.branchStock).length;
      return {
        totalProducts: a.totalProducts + (inCatalogue ? 1 : 0),
        totalSales: a.totalSales + p.sale,
        positiveSales: a.positiveSales + p.pos,
        negativeSales: a.negativeSales + p.neg,
        amount: a.amount + (p.amount ?? 0),
        totalInventory: a.totalInventory + p.stock,
        negativeStock:
          a.negativeStock + (Object.values(p.branchStock).some((q) => q < 0) ? 1 : 0),
        // Zero somewhere = not stocked at every covered branch, the same
        // definition levels 1 and 2 use.
        zeroStock: a.zeroStock + (inCatalogue && stocked < branchesCovered ? 1 : 0),
        // In stock, sold nothing over the range.
        zeroSales: a.zeroSales + (p.stock > 0 && p.sale === 0 ? 1 : 0),
      };
    },
    { totalProducts: 0, totalSales: 0, positiveSales: 0, negativeSales: 0, amount: 0,
      totalInventory: 0, negativeStock: 0, zeroStock: 0, zeroSales: 0 }
  );
  if (!includeAmount) {
    delete stats.amount;
    for (const p of all) {
      delete p.amount;
      delete p.branchAmount;
    }
  }

  // Unknown, not zero — same reasoning as levels 1 and 2. Without this every
  // product looked out of stock whenever the range predated the snapshot.
  if (!stockDate) {
    stats.totalInventory = null;
    stats.negativeStock = null;
    stats.zeroStock = null;
    stats.zeroSales = null;
  }

  const slice = visible.slice((page - 1) * pageSize, page * pageSize);

  // Names came back with the catalogue seed, so no second lookup is needed.
  const byId = meta;

  return {
    products: slice.map((x) => ({
      ...x,
      articleName: byId.get(x.barcode)?.articleName ?? "(unknown)",
      type: byId.get(x.barcode)?.type ?? "",
      sellingStatus: byId.get(x.barcode)?.sellingStatus ?? "",
    })),
    stats,
    branches: [...branchCount].sort(),
    query: term,
    unfilteredTotal: all.length,
    total,
    page,
    pageSize,
    stockDate: stockDate ? dateSlug(stockDate) : null,
  };
}

/**
 * The dashboard read.
 *
 * The two dimensions answer a date range differently, because they mean
 * different things:
 *
 *   Sales are events — summed across [from, to].
 *   Stock is a position — resolved to a point: the most recent snapshot on or
 *   before `to`. Summing stock over a period would be meaningless.
 *
 * The resolved stock date is returned so the UI can state which snapshot the
 * stock figures came from rather than implying they match the sales range.
 */
/**
 * The dashboard read.
 *
 * The two dimensions answer a date range differently, because they mean
 * different things:
 *
 *   Sales are events — summed across [from, to].
 *   Stock is a position — resolved to a point: the most recent snapshot on or
 *   before `to`. Summing stock over a period would be meaningless.
 *
 * The resolved stock date is returned so the UI can state which snapshot the
 * stock figures came from rather than implying they match the sales range.
 */
export async function readDashboard({
  branch = ALL,
  type = ALL,
  sellingStatus = ALL,
  from = null,
  to = null,
  category = null,
  metricFilter = null,
  scope = UNRESTRICTED,
  // Revenue is admin-only, so it is not computed at all for anyone else rather
  // than computed and then hidden — a field omitted from the response cannot
  // leak through the API.
  includeAmount = false,
} = {}) {
  const database = db();

  // The user's scope is folded into the queries themselves, so out-of-scope
  // rows are never read. An empty array back from resolveAllowed means the
  // request fell outside what this account may see — which has to mean "no
  // rows", never "no filter".
  const branchIn = resolveAllowed(branch, scope.branches);
  const categoryIn = resolveAllowed(category, scope.categories);
  const outOfScope = isEmptyScope(branchIn, categoryIn);

  const cubeMatch = {};
  const branchCond = condition(branchIn);
  if (branchCond !== undefined) cubeMatch.branch = branchCond;
  if (type !== ALL) cubeMatch.type = type;
  if (sellingStatus !== ALL) cubeMatch.sellingStatus = sellingStatus;
  const categoryCond = condition(categoryIn);
  if (categoryCond !== undefined) cubeMatch.category = categoryCond;
  if (from || to) {
    cubeMatch.date = {};
    if (from) cubeMatch.date.$gte = from;
    if (to) cubeMatch.date.$lte = to;
  }

  // Newest snapshot at or before the end of the range; the newest overall when
  // no range is set. Null means no snapshot exists that early, in which case
  // stock figures are omitted rather than silently showing a later count.
  const stockDate = await resolveStockDate(database, to);

  // stock_cube stores a pre-aggregated branch:"ALL" row so product counts are
  // not double-counted across branches. That row is only usable when the view
  // really is every branch — a user restricted to a subset must be counted from
  // inventory_state instead, which is what `useStateForStock` below selects.
  const stockMatch = stockDate
    ? { date: stockDate, branch: branchIn === null ? ALL : branchIn[0] }
    : { _id: null };
  if (type !== ALL) stockMatch.type = type;
  if (sellingStatus !== ALL) stockMatch.sellingStatus = sellingStatus;
  if (categoryCond !== undefined) stockMatch.category = categoryCond;

  // Level 1 (categories) reads the cubes. Level 2 (sub-categories within one
  // category) reads the FACTS instead, because sub-category is deliberately not
  // a cube dimension — adding it multiplied stock_cube 11x for a drill-down that
  // is a deliberate click rather than the default view. The facts carry
  // category/subCategory denormalised, so this is an indexed match, not a join.
  const drilled = Boolean(category);

  // type and sellingStatus live on `products`, not on the facts. When either is
  // filtered, the matching barcodes are resolved first and applied as an $in —
  // otherwise a drill-down would silently ignore filters the user had set at the
  // level above, and show more than they asked for.
  // How many branches the snapshot covered. Zero stock at "All branches" means
  // a product is missing a reading at at least one of them.
  // "Stocked everywhere" is measured against the branches this user can see. A
  // user scoped to two branches must not have a product counted as zero-stock
  // because it is absent from a third they are not allowed to look at.
  const coveredBranches =
    (await database.collection(COL.COVERAGE).distinct("branch")).length || BRANCH_CODES.length;
  const branchCount = branchIn === null ? coveredBranches : branchIn.length;

  // Sub-category and product restrictions apply to every fact- and
  // state-derived figure below.
  const subCond = condition(scope.subCategories ? [...scope.subCategories] : null);
  const productCond = condition(scope.products ? [...scope.products] : null);

  let barcodeFilter = null;
  if (drilled && (type !== ALL || sellingStatus !== ALL)) {
    const q = { category };
    if (type !== ALL) q.type = type;
    if (sellingStatus !== ALL) q.sellingStatus = sellingStatus;
    if (subCond !== undefined) q.subCategory = subCond;
    if (productCond !== undefined) q._id = productCond;
    const ids = await database.collection(COL.PRODUCTS).find(q, { projection: { _id: 1 } }).toArray();
    barcodeFilter = ids.map((x) => x._id);
  }

  const factSalesMatch = {};
  if (categoryCond !== undefined) factSalesMatch.category = categoryCond;
  if (branchCond !== undefined) factSalesMatch.branch = branchCond;
  if (subCond !== undefined) factSalesMatch.subCategory = subCond;
  if (productCond !== undefined) factSalesMatch.barcode = productCond;
  if (barcodeFilter) factSalesMatch.barcode = { $in: barcodeFilter };
  if (from || to) {
    factSalesMatch.date = {};
    if (from) factSalesMatch.date.$gte = from;
    if (to) factSalesMatch.date.$lte = to;
  }
  // Same rule as level 1 and level 3: the held snapshot counts only when it is
  // the one the date range resolves to. Without this, drilling into a category
  // showed today's stock beside level 1's correctly-empty figure.
  const factStockMatch = { asOf: stockDate };
  if (categoryCond !== undefined) factStockMatch.category = categoryCond;
  if (branchCond !== undefined) factStockMatch.branch = branchCond;
  if (subCond !== undefined) factStockMatch.subCategory = subCond;
  if (productCond !== undefined) factStockMatch.barcode = productCond;
  if (barcodeFilter) factStockMatch.barcode = { $in: barcodeFilter };

  // Stock comes from inventory_state whenever the pre-aggregated ALL row cannot
  // be used: drilled into a category, or scoped to a subset of branches.
  const useStateForStock =
    drilled || (branchIn !== null && branchIn.length > 1) || subCond !== undefined || productCond !== undefined;
  const stockGroupField = drilled ? "$subCategory" : "$category";

  // daily_cube has no sub-category or barcode dimension, so any scope narrower
  // than whole categories has to be answered from the facts instead.
  const useFactsForSales = drilled || subCond !== undefined || productCond !== undefined;
  const salesGroupField = drilled ? "$subCategory" : "$category";

  const noMatches = (barcodeFilter !== null && barcodeFilter.length === 0) || outOfScope;
  const noStock = noMatches || !stockDate;

  // Fetched up front, not alongside the aggregations: dead stock needs the last
  // sale date to know whether it can take its cheap path, and waiting for the
  // whole batch before starting it cost a second of serialised time.
  const meta = await database.collection(COL.META).findOne({ _id: "filters" });

  const [sales, stock, deadStock] = await Promise.all([
    noMatches ? Promise.resolve([]) : useFactsForSales
      ? database
          .collection(COL.SALES_FACTS)
          .aggregate([
            { $match: factSalesMatch },
            {
              $group: {
                _id: salesGroupField,
                totalSales: { $sum: "$qty" },
                positiveSales: { $sum: { $cond: [{ $gt: ["$qty", 0] }, "$qty", 0] } },
                negativeSales: { $sum: { $cond: [{ $lt: ["$qty", 0] }, "$qty", 0] } },
                ...(includeAmount
                  ? { amount: { $sum: { $multiply: ["$qty", { $ifNull: ["$rate", 0] }] } } }
                  : {}),
              },
            },
          ])
          .toArray()
      : database
          .collection(COL.DAILY_CUBE)
          .aggregate([
            { $match: cubeMatch },
            {
              $group: {
                _id: "$category",
                totalSales: { $sum: "$sale" },
                positiveSales: { $sum: "$pos" },
                negativeSales: { $sum: "$neg" },
                ...(includeAmount ? { amount: { $sum: { $ifNull: ["$amount", 0] } } } : {}),
              },
            },
          ])
          .toArray(),
    noStock ? Promise.resolve([]) : useStateForStock
      ? database
          .collection(COL.INVENTORY_STATE)
          .aggregate([
            { $match: factStockMatch },
            // Collapse to one row per product first. A product stocked at eight
            // branches has eight inventory_state rows, so counting rows would
            // report it eight times under "All Branches".
            {
              $group: {
                _id: { sub: stockGroupField, barcode: "$barcode" },
                qty: { $sum: "$qty" },
                branchesWithStock: { $sum: 1 },
                neg: { $max: { $cond: [{ $lt: ["$qty", 0] }, 1, 0] } },
              },
            },
            {
              $group: {
                _id: "$_id.sub",
                totalInventory: { $sum: "$qty" },
                withStock: { $sum: 1 },
                // "Stocked everywhere" — needed because zero stock means zero at
                // ANY branch, which is the definition level 1 uses. Counting
                // products with no stock at all instead reported far fewer.
                stockedEverywhere: {
                  $sum: { $cond: [{ $gte: ["$branchesWithStock", branchCount] }, 1, 0] },
                },
                negativeStockCount: { $sum: "$neg" },
              },
            },
          ])
          .toArray()
      : database
          .collection(COL.STOCK_CUBE)
          .aggregate([
            { $match: stockMatch },
            {
              $group: {
                _id: "$category",
                productCount: { $sum: "$productCount" },
                totalInventory: { $sum: "$totalQty" },
                negativeStockCount: { $sum: "$negativeStockCount" },
                zeroStockCount: { $sum: "$zeroStockCount" },
              },
            },
          ])
          .toArray(),
    noMatches
      ? Promise.resolve(new Map())
      : readDeadStock({
          database, branch, type, sellingStatus, from, to, category, scope,
          // maxSalesDate, not maxDate: a stock snapshot dated after the last
          // sale must not make the cheap path look valid past that sale.
          stockDate, maxSalesDate: meta?.maxSalesDate ?? meta?.maxDate ?? null,
        }),
  ]);

  // Zero stock is derived, never stored — a product the snapshot covered with no
  // non-zero reading read zero. At level 2 that needs the full product count per
  // sub-category, which only `products` knows.
  let subProductCounts = new Map();
  if (useStateForStock && !noMatches) {
    const q = { stockAsOf: { $ne: null } };
    if (categoryCond !== undefined) q.category = categoryCond;
    if (type !== ALL) q.type = type;
    if (sellingStatus !== ALL) q.sellingStatus = sellingStatus;
    if (subCond !== undefined) q.subCategory = subCond;
    if (productCond !== undefined) q._id = productCond;
    const rows = await database
      .collection(COL.PRODUCTS)
      .aggregate([
        { $match: q },
        {
          $group: {
            _id: { $ifNull: [drilled ? "$subCategory" : "$category", ""] },
            n: { $sum: 1 },
          },
        },
      ])
      .toArray();
    subProductCounts = new Map(rows.map((r) => [r._id, r.n]));
  }

  const merged = new Map();
  const slot = (name) => {
    const keyName = name || UNCATEGORIZED;
    if (!merged.has(keyName)) {
      merged.set(keyName, {
        categoryName: keyName,
        totalSales: 0, positiveSales: 0, negativeSales: 0, amount: 0,
        totalInventory: 0, productCount: 0,
        negativeStockCount: 0, zeroStockCount: 0, zeroSalesCount: 0,
      });
    }
    return merged.get(keyName);
  };

  for (const s of sales) Object.assign(slot(s._id), {
    totalSales: s.totalSales, positiveSales: s.positiveSales, negativeSales: s.negativeSales,
    ...(includeAmount ? { amount: s.amount ?? 0 } : {}),
  });
  for (const s of stock) {
    const t = slot(s._id);
    // Keyed off the same switch that chose the source. Reading the cube's shape
    // from an inventory_state result left productCount undefined, which surfaced
    // as a null product count the moment any scope was applied.
    if (useStateForStock) {
      const total = subProductCounts.get(s._id ?? "") ?? s.withStock ?? 0;
      // Zero somewhere = not stocked at every covered branch. For a single
      // branch that reduces to "has no reading here", which is the same thing.
      const fullyStocked = branch === ALL ? (s.stockedEverywhere ?? 0) : (s.withStock ?? 0);
      t.productCount = total;
      t.totalInventory = s.totalInventory;
      t.negativeStockCount = s.negativeStockCount;
      t.zeroStockCount = Math.max(0, total - fullyStocked);
    } else {
      t.productCount = s.productCount;
      t.totalInventory = s.totalInventory;
      t.negativeStockCount = s.negativeStockCount;
      t.zeroStockCount = s.zeroStockCount;
    }
  }

  // Every dead-stock group needs a row even when it has neither sales nor stock
  // rows above — a sub-category where nothing sold is exactly what this metric
  // exists to surface, and it would otherwise be missing from the list.
  for (const [name, n] of deadStock) slot(name).zeroSalesCount = n;

  // A sub-category can have products but no stock rows at all — it still needs
  // a row, with everything at zero, rather than being absent.
  if (useStateForStock) {
    for (const [sub, total] of subProductCounts) {
      const t = slot(sub);
      if (t.productCount === 0) {
        t.productCount = total;
        t.zeroStockCount = total;
      }
    }
  }

  // No snapshot covers this range, so stock is UNKNOWN, not zero. Left as
  // numbers it reads as fact: every product counted as zero-stock, which made
  // "zero stock" equal the product count exactly and told the user 512 items
  // were out of stock when nothing had been counted at all. Null lets the UI
  // show a dash instead of a made-up figure.
  if (!stockDate) {
    for (const c of merged.values()) {
      c.totalInventory = null;
      c.negativeStockCount = null;
      c.zeroStockCount = null;
      c.zeroSalesCount = null;
    }
  }

  // Tiebreak on name: many categories sit at zero sales, and without it their
  // card order changes between requests.
  const allCategories = [...merged.values()].sort(
    (a, b) => b.totalSales - a.totalSales || a.categoryName.localeCompare(b.categoryName)
  );
  // Filtered for display only. The headline figures below are deliberately
  // computed over everything, so clicking "negative stock" narrows the list
  // without changing the number on the card that was clicked.
  const categories = allCategories.filter(rowMatchesMetric(metricFilter));

  const stats = allCategories.reduce(
    (a, c) => ({
      totalProducts: a.totalProducts + c.productCount,
      totalInventory: a.totalInventory + (c.totalInventory ?? 0),
      totalSales: a.totalSales + c.totalSales,
      positiveSales: a.positiveSales + c.positiveSales,
      negativeSales: a.negativeSales + c.negativeSales,
      amount: a.amount + (c.amount ?? 0),
      negativeStock: a.negativeStock + (c.negativeStockCount ?? 0),
      zeroStock: a.zeroStock + (c.zeroStockCount ?? 0),
      zeroSales: a.zeroSales + (c.zeroSalesCount ?? 0),
    }),
    { totalProducts: 0, totalInventory: 0, totalSales: 0, positiveSales: 0,
      negativeSales: 0, amount: 0, negativeStock: 0, zeroStock: 0, zeroSales: 0 }
  );
  if (!includeAmount) {
    delete stats.amount;
    for (const c of allCategories) delete c.amount;
  }

  // The headline cards get the same treatment, for the same reason.
  if (!stockDate) {
    stats.totalInventory = null;
    stats.negativeStock = null;
    stats.zeroStock = null;
    stats.zeroSales = null;
  }

  return {
    ready: Boolean(meta),
    dateFiltered: Boolean(from || to),
    // Which snapshot the stock figures came from, so the UI can name it rather
    // than implying stock covers the same range as sales.
    stockDate: stockDate ? dateSlug(stockDate) : null,
    stockAvailable: Boolean(stockDate),
    stats,
    categories,
    filtersList: {
      // Restricted to the scope, so the dropdowns cannot offer a branch or
      // category that every query would then refuse to answer.
      branches: (meta?.branches ?? BRANCH_CODES).filter(
        (b) => !scope.branches || scope.branches.includes(b)
      ),
      categories: (meta?.categories ?? []).filter(
        (c) => !scope.categories || scope.categories.includes(c)
      ),
      types: meta?.types ?? [],
      statuses: meta?.statuses ?? [],
      minDate: meta?.minDate ?? null,
      maxDate: meta?.maxDate ?? null,
    },
  };
}
