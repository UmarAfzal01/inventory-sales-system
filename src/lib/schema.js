/**
 * Canonical schema for the inventory/sales warehouse.
 *
 * Design notes that matter:
 *
 * - Dates are real `Date` values at UTC midnight, never strings. The previous
 *   model keyed records by "2026|AUG-26|DAY19", which neither sorts nor supports
 *   range queries, so date filtering was impossible.
 *
 * - Branches are declared here, not inferred from spreadsheet columns. Inferring
 *   them by exclusion meant any stray column (SR NO, TOTAL) silently became a
 *   branch full of fake quantities.
 *
 * - `inventory_state` stores only NON-ZERO readings. A full snapshot is 2.33M
 *   cells of which ~78% are zero; storing them all costs ~250MB plus indexes and
 *   would not fit an M0 cluster. Zero counts are derived from snapshot coverage
 *   instead, which gives identical answers. See `rebuildStockCube` in warehouse.js.
 *
 * - A blank cell is absent data, NOT zero. Conflating the two is what made
 *   "zero stock" report ~197k of 197k products.
 */

export const COL = {
  PRODUCTS: "products",
  BRANCHES: "branches",
  SALES_FACTS: "sales_facts",
  INVENTORY_STATE: "inventory_state",
  COVERAGE: "snapshot_coverage",
  DAILY_CUBE: "daily_cube",
  STOCK_CUBE: "stock_cube",
  BATCHES: "upload_batches",
  META: "meta",
};

/**
 * Every branch that may appear as a spreadsheet column.
 *
 * CW appears in inventory sheets but never in sales sheets — it is a warehouse,
 * not a retail branch, so it legitimately has stock and no sales. The dashboard
 * labels it so that zero sales does not read as broken data.
 */
export const BRANCHES = [
  { _id: "WT", name: "WT", kind: "retail", sells: true },
  { _id: "DFNR", name: "DFNR", kind: "retail", sells: true },
  { _id: "BTL", name: "BTL", kind: "retail", sells: true },
  { _id: "EME", name: "EME", kind: "retail", sells: true },
  { _id: "GUJ", name: "GUJ", kind: "retail", sells: true },
  { _id: "MT", name: "MT", kind: "retail", sells: true },
  { _id: "SHKP", name: "SHKP", kind: "retail", sells: true },
  { _id: "RWP", name: "RWP", kind: "retail", sells: true },
  { _id: "SHDR", name: "SHDR", kind: "retail", sells: true },
  { _id: "BRL", name: "BRL", kind: "retail", sells: true },
  { _id: "CW", name: "CW", kind: "warehouse", sells: false },
];

export const BRANCH_CODES = BRANCHES.map((b) => b._id);

/** Non-branch columns, normalised to trimmed uppercase. */
export const META_COLUMNS = {
  CATEGORY: ["1ST LEVEL CATEGORY", "1ST LEVEL CATE"],
  SUB_CATEGORY: ["LAST LEVEL CATEGORY"],
  ARTICLE_NAME: ["ARTICLE NAME"],
  BARCODE: ["BARCODE"],
  TYPE: ["TYPE"],
  SELLING_STATUS: ["SELLING STATUS"],
  SALE_RATE: ["SALE RATE"],
  COST_PRICE: ["COST PRICE"],
  MONTH: ["MONTH"],
  DAY: ["DAY"],
};

export const ALL_META_HEADERS = Object.values(META_COLUMNS).flat();

/** Columns a sheet must contain, by file type. */
export const REQUIRED_HEADERS = {
  sale: ["BARCODE", "ARTICLE NAME", "MONTH", "DAY"],
  inventory: ["BARCODE", "ARTICLE NAME"],
};

/** Sentinel values Excel leaves behind that must not become real dimensions. */
export const JUNK_VALUES = new Set(["#N/A", "#REF!", "#VALUE!", "#NAME?", "#DIV/0!", "NULL", "NA"]);

export const UNCATEGORIZED = "UNCATEGORIZED";

// Resolved once the schema has been applied in this process. Every dashboard
// request used to re-run the whole thing — a listCollections, nine collMods and
// twenty-three createIndex commands before a single row was read, which on a
// throttled cluster is a visible chunk of page-load time. It also quietly
// undoes any index dropped by hand to reclaim space.
let schemaReady = null;

/**
 * Creates collections with validators and indexes. Idempotent — safe to re-run.
 *
 * Runs its real work once per process; later calls await the same promise. Pass
 * `{ force: true }` to re-apply after dropping a collection or an index.
 */
export async function ensureSchema(db, { force = false } = {}) {
  if (force) schemaReady = null;
  if (!schemaReady) {
    // Cache the promise, not the result, so concurrent callers share one run —
    // and clear it on failure so the next call retries rather than assuming.
    schemaReady = applySchema(db).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

async function applySchema(db) {
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
  const create = async (name, validator) => {
    if (existing.has(name)) {
      if (validator) await db.command({ collMod: name, validator, validationLevel: "moderate" });
      return;
    }
    await db.createCollection(name, validator ? { validator } : {});
  };

  await create(COL.PRODUCTS, {
    $jsonSchema: {
      bsonType: "object",
      required: ["_id", "articleName"],
      properties: {
        _id: { bsonType: "string" }, // barcode — duplicates become a hard error
        articleName: { bsonType: "string" },
        category: { bsonType: "string" },
        subCategory: { bsonType: "string" },
        type: { bsonType: "string" },
        sellingStatus: { bsonType: "string" },
        saleRate: { bsonType: ["double", "int", "long", "null"] },
        costPrice: { bsonType: ["double", "int", "long", "null"] },
        stockAsOf: { bsonType: ["date", "null"] },
      },
    },
  });

  await create(COL.BRANCHES, null);

  await create(COL.SALES_FACTS, {
    $jsonSchema: {
      bsonType: "object",
      required: ["_id", "date", "branch", "barcode", "qty"],
      properties: {
        date: { bsonType: "date" }, // real Date, never a string key
        branch: { bsonType: "string" },
        barcode: { bsonType: "string" },
        qty: { bsonType: ["double", "int", "long"] },
      },
    },
  });

  await create(COL.INVENTORY_STATE, {
    $jsonSchema: {
      bsonType: "object",
      required: ["_id", "branch", "barcode", "qty"],
      properties: {
        branch: { bsonType: "string" },
        barcode: { bsonType: "string" },
        // Only non-zero readings are stored. null is impossible here: a missing
        // reading means no document, which is what keeps blank distinct from 0.
        qty: { bsonType: ["double", "int", "long"] },
        asOf: { bsonType: "date" },
      },
    },
  });

  await create(COL.COVERAGE, null);
  await create(COL.DAILY_CUBE, null);
  await create(COL.STOCK_CUBE, null);
  await create(COL.BATCHES, null);
  await create(COL.META, null);

  /**
   * Creates an index, replacing any existing one that has the same name but
   * different options. Without this, changing an index definition throws
   * IndexOptionsConflict on every request and the app stops working — the
   * auto-generated name collides with the old definition.
   */
  const index = async (name, keys, options = {}) => {
    const col = db.collection(name);
    const spec = { name: options.name ?? Object.keys(keys).join("_"), ...options };
    try {
      await col.createIndex(keys, spec);
    } catch (err) {
      if (err.codeName === "IndexOptionsConflict" || err.code === 85 || err.code === 86) {
        await col.dropIndex(spec.name).catch(() => {});
        await col.createIndex(keys, spec);
      } else throw err;
    }
  };

  /*
   * Index policy: every index here must serve a query the application actually
   * makes. $indexStats showed several that served none — they were costing
   * storage and slowing every write for nothing.
   *
   * Removed, and why:
   *   products  {category, type, sellingStatus}  cube rebuilds group by these
   *       but match on stockAsOf, so the index was never chosen. Re-add if a
   *       product listing screen is built.
   *   sales_facts {barcode, date}   for per-product sales history — not built.
   *   sales_facts {batchId}         for batch reversal — not built.
   *   upload_batches {uploadedAt}   for an upload history screen — not built.
   *
   * Kept despite low op counts, because they serve rare-but-critical paths:
   *   sales_facts {date, branch}    commitSales deletes a day before rewriting
   *       it; without this that becomes a full collection scan on every upload.
   *   inventory_state {barcode}     the $lookup in rebuildStockCube resolves
   *       211k products against it; without it that is a scan per product.
   */
  await Promise.all([
    index(COL.SALES_FACTS, { date: 1, branch: 1 }),
    // Drill-down reads facts directly: cubes aggregate the product away, so
    // product-level listing is impossible from them. These serve level 2
    // (sub-category) and level 3 (products within one).
    index(COL.SALES_FACTS, { category: 1, subCategory: 1, date: 1 }),
    index(COL.SALES_FACTS, { barcode: 1, date: 1 }),
    index(COL.INVENTORY_STATE, { category: 1, subCategory: 1 }),
    // Level 3 seeds its list from the catalogue so out-of-stock, non-selling
    // products still appear; this keeps that a seek rather than a 194k scan.
    index(COL.PRODUCTS, { category: 1, subCategory: 1 }),
    // `barcode` serves the $lookup in rebuildStockCube and is needed.
    //
    // There was a { branch, qty } index here too. On 500k documents it cost
    // 44MB — a third of this collection's index footprint — and nothing in the
    // application ever used it: zero and negative counts are read from
    // stock_cube, never by querying inventory_state directly. $indexStats
    // showed its only hits came from ad-hoc verification queries. Removed.
    index(COL.INVENTORY_STATE, { barcode: 1 }),
    // Cube reads are always scoped to the published build, so it leads the key.
    index(COL.DAILY_CUBE, { date: 1, branch: 1 }),
    index(COL.DAILY_CUBE, { branch: 1, type: 1, sellingStatus: 1, date: 1 }),
    // Stock cubes are per snapshot date; `date` leads because every read first
    // resolves which snapshot to use, then filters within it.
    index(COL.STOCK_CUBE, { date: 1, branch: 1, type: 1, sellingStatus: 1 }),
    index(COL.STOCK_CUBE, { date: 1, branch: 1, category: 1 }),
    index(COL.DAILY_CUBE, { branch: 1, category: 1, date: 1 }),
    index(COL.COVERAGE, { date: 1, branch: 1 }),
    // A file may only be ingested once — but only a COMMITTED batch reserves its
    // hash. A plain unique index would let a failed upload block its own retry
    // forever, which is precisely the wrong behaviour after a transient error.
    index(
      COL.BATCHES,
      { fileHash: 1 },
      { name: "fileHash_committed", unique: true, partialFilterExpression: { status: "committed" } }
    ),
    // At most one upload may be running at a time, enforced by the database
    // rather than by a check in the route. Checking first and inserting after is
    // a race: two simultaneous uploads both find nothing and both proceed, which
    // is exactly what happened — they doubled peak memory and rebuilt cubes from
    // facts the other was still writing.
    index(
      COL.BATCHES,
      { status: 1 },
      { name: "one_running_at_a_time", unique: true, partialFilterExpression: { status: "running" } }
    ),
  ]);

  // Seed the branch registry.
  await db.collection(COL.BRANCHES).bulkWrite(
    BRANCHES.map((b) => ({
      updateOne: { filter: { _id: b._id }, update: { $set: b }, upsert: true },
    }))
  );

  return { collections: Object.values(COL), branches: BRANCH_CODES.length };
}
