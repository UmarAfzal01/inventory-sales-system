import mongoose from "mongoose";
import { COL, BRANCH_CODES, UNCATEGORIZED } from "@/lib/schema";
import { dateSlug } from "@/lib/ingest";

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
  const products = new Map();
  for (const r of rows) {
    products.set(r.barcode, {
      ...r.product,
      ...(fileType === "inventory" && isNewer ? { stockAsOf: r.date } : {}),
    });
  }
  await chunk([...products.entries()], 1000, (batch) =>
    database.collection(COL.PRODUCTS).bulkWrite(
      batch.map(([barcode, p]) => ({
        updateOne: {
          filter: { _id: barcode },
          update: fileType === "inventory" ? { $set: p } : { $setOnInsert: p },
          upsert: true,
        },
      })),
      { ordered: false }
    )
  );

  if (fileType === "sale") {
    await commitSales({ database, rows, batchId, dates });
    // Only the uploaded days are re-aggregated. Rebuilding everything made an
    // upload's cost grow with total history — quadratic across a backfill.
    await rebuildDailyCube(database, dates);
    return { products: products.size };
  }

  const written = await commitInventory({ database, rows, batchId, dates, isNewer });

  // The stock cube is built from the SHEET, not from inventory_state. A
  // back-dated sheet leaves inventory_state alone, so reading it would file
  // today's numbers under an old date. Building from the sheet also makes the
  // cube reflect exactly what that snapshot covered.
  await buildStockCubeFromRows({ database, rows, date: dates[0] });

  return {
    products: products.size,
    currentPositionUpdated: isNewer,
    heldAsOf: currentAsOf ? dateSlug(currentAsOf) : null,
    readings: written,
  };
}

async function commitSales({ database, rows, batchId, dates }) {
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
      seen.set(_id, c.qty);
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
  for (const [_id, qty] of seen) {
    if (qty === 0) continue; // absence encodes zero
    const [branch, ...rest] = _id.split("|");
    docs.push({ _id, branch, barcode: rest.join("|"), qty, asOf, batchId });
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
              c: { $ifNull: ["$p.category", UNCATEGORIZED] },
              t: { $ifNull: ["$p.type", ""] },
              s: { $ifNull: ["$p.sellingStatus", ""] },
            },
            sale: { $sum: "$qty" },
            pos: { $sum: { $cond: [{ $gt: ["$qty", 0] }, "$qty", 0] } },
            neg: { $sum: { $cond: [{ $lt: ["$qty", 0] }, "$qty", 0] } },
            products: { $addToSet: "$barcode" },
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
            sale: 1, pos: 1, neg: 1,
            productCount: { $size: "$products" },
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

/** Filter options and the available date range, recomputed after each upload. */
export async function rebuildMeta() {
  const database = db();
  const [types, statuses, categories, range] = await Promise.all([
    database.collection(COL.PRODUCTS).distinct("type"),
    database.collection(COL.PRODUCTS).distinct("sellingStatus"),
    database.collection(COL.PRODUCTS).distinct("category"),
    database
      .collection(COL.SALES_FACTS)
      .aggregate([{ $group: { _id: null, min: { $min: "$date" }, max: { $max: "$date" } } }])
      .toArray(),
  ]);

  const doc = {
    branches: BRANCH_CODES,
    types: types.filter(Boolean).sort(),
    statuses: statuses.filter(Boolean).sort(),
    categories: categories.filter(Boolean).sort(),
    minDate: range[0]?.min ?? null,
    maxDate: range[0]?.max ?? null,
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
} = {}) {
  const database = db();

  const cubeMatch = {};
  if (branch !== ALL) cubeMatch.branch = branch;
  if (type !== ALL) cubeMatch.type = type;
  if (sellingStatus !== ALL) cubeMatch.sellingStatus = sellingStatus;
  if (category) cubeMatch.category = category;
  if (from || to) {
    cubeMatch.date = {};
    if (from) cubeMatch.date.$gte = from;
    if (to) cubeMatch.date.$lte = to;
  }

  // Newest snapshot at or before the end of the range; the newest overall when
  // no range is set. Null means no snapshot exists that early, in which case
  // stock figures are omitted rather than silently showing a later count.
  const stockDate = await resolveStockDate(database, to);

  const stockMatch = stockDate ? { date: stockDate, branch } : { _id: null };
  if (type !== ALL) stockMatch.type = type;
  if (sellingStatus !== ALL) stockMatch.sellingStatus = sellingStatus;
  if (category) stockMatch.category = category;

  // If a category drill-down is active, group by subCategory; otherwise group by top-level category
  const groupField = category ? "$subCategory" : "$category";

  const [sales, stock, meta] = await Promise.all([
    database
      .collection(COL.DAILY_CUBE)
      .aggregate([
        { $match: cubeMatch },
        {
          $group: {
            _id: groupField,
            totalSales: { $sum: "$sale" },
            positiveSales: { $sum: "$pos" },
            negativeSales: { $sum: "$neg" },
          },
        },
      ])
      .toArray(),
    database
      .collection(COL.STOCK_CUBE)
      .aggregate([
        { $match: stockMatch },
        {
          $group: {
            _id: groupField,
            productCount: { $sum: "$productCount" },
            totalInventory: { $sum: "$totalQty" },
            negativeStockCount: { $sum: "$negativeStockCount" },
            zeroStockCount: { $sum: "$zeroStockCount" },
          },
        },
      ])
      .toArray(),
    database.collection(COL.META).findOne({ _id: "filters" }),
  ]);

  const merged = new Map();
  const slot = (name) => {
    const keyName = name || UNCATEGORIZED;
    if (!merged.has(keyName)) {
      merged.set(keyName, {
        categoryName: keyName,
        totalSales: 0, positiveSales: 0, negativeSales: 0,
        totalInventory: 0, productCount: 0,
        negativeStockCount: 0, zeroStockCount: 0,
      });
    }
    return merged.get(keyName);
  };

  for (const s of sales) Object.assign(slot(s._id), {
    totalSales: s.totalSales, positiveSales: s.positiveSales, negativeSales: s.negativeSales,
  });
  for (const s of stock) Object.assign(slot(s._id), {
    productCount: s.productCount, totalInventory: s.totalInventory,
    negativeStockCount: s.negativeStockCount, zeroStockCount: s.zeroStockCount,
  });

  // Tiebreak on name: many categories sit at zero sales, and without it their
  // card order changes between requests.
  const categories = [...merged.values()].sort(
    (a, b) => b.totalSales - a.totalSales || a.categoryName.localeCompare(b.categoryName)
  );

  const stats = categories.reduce(
    (a, c) => ({
      totalProducts: a.totalProducts + c.productCount,
      totalInventory: a.totalInventory + c.totalInventory,
      totalSales: a.totalSales + c.totalSales,
      positiveSales: a.positiveSales + c.positiveSales,
      negativeSales: a.negativeSales + c.negativeSales,
      negativeStock: a.negativeStock + c.negativeStockCount,
      zeroStock: a.zeroStock + c.zeroStockCount,
    }),
    { totalProducts: 0, totalInventory: 0, totalSales: 0, positiveSales: 0,
      negativeSales: 0, negativeStock: 0, zeroStock: 0 }
  );

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
      branches: meta?.branches ?? BRANCH_CODES,
      types: meta?.types ?? [],
      statuses: meta?.statuses ?? [],
      minDate: meta?.minDate ?? null,
      maxDate: meta?.maxDate ?? null,
    },
  };
}
