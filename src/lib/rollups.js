import Product from "@/models/Product";

/**
 * Incremental dashboard rollups.
 *
 * The dashboard used to be answered by scanning the whole `products` collection
 * and summing in JavaScript (15-20 min). Moving the aggregation server-side got
 * that to ~10s, and pre-aggregating got it to ~0.2s — but the pre-aggregation
 * was rebuilt by re-scanning every product after every upload, so the cost of an
 * upload grew with all accumulated history.
 *
 * These rollups are instead maintained from the uploaded sheet itself, which is
 * already parsed and in memory. Nothing here scans `products`.
 *
 *   rollup_daily      additive metrics per (date, branch, category, type, status)
 *   product_state     latest inventory per (barcode, branch)
 *   dashboard_counts  distinct-product counts per (branch, category, type, status)
 *   dashboard_meta    filter dropdown options
 *
 * Additive metrics (sales, inventory) live in rollup_daily because summing them
 * across days is exact. Distinct-product counts cannot be summed that way — a
 * product out of stock on two days is still one product — so they are derived
 * from product_state, which holds current state rather than history.
 */

export const DAILY = "rollup_daily";
export const STATE = "product_state";
export const COUNTS = "dashboard_counts";
export const META = "dashboard_meta";

export const ALL = "ALL";

const db = () => Product.db;

/** Stable key for one rollup_daily cell. */
const cellId = (dateKey, branch, cat, type, status) =>
  `${dateKey}|${branch}|${cat}|${type}|${status}`;

/** Empty string is how the sheet represents "no value"; the UI shows a label. */
const norm = (v) => String(v ?? "").trim();

/**
 * Folds one upload into rollup cells and per-product state, entirely in memory.
 *
 * `rows` are the already-normalised sheet rows. `branchKeysOf` extracts the
 * branch columns from a row (the caller knows which headers are metadata).
 *
 * Returns the writes to apply; performing them is `commitUpload`'s job, so this
 * stays pure and testable.
 */
export function foldUpload({ rows, branchKeysOf, dateKeyOf, fileType }) {
  const cells = new Map();
  const state = new Map();

  for (const row of rows) {
    const barcode = norm(row["BARCODE"]);
    if (!barcode) continue;

    const cat = norm(row["1ST LEVEL CATEGORY"] || row["1ST LEVEL CATE"]) || "UNCATEGORIZED";
    const type = norm(row["TYPE"]);
    const status = norm(row["SELLING STATUS"]);
    const dateKey = dateKeyOf(row);

    for (const branch of branchKeysOf(row)) {
      const raw = row[branch];
      // A blank cell is absent data, not a zero. This distinction is the whole
      // reason zeroStock used to report ~197k of 197k products.
      if (raw === undefined || raw === null || raw === "") continue;
      const qty = Number(raw);
      if (!Number.isFinite(qty)) continue;

      const id = cellId(dateKey, branch, cat, type, status);
      let cell = cells.get(id);
      if (!cell) {
        cell = { _id: id, dateKey, branch, cat, type, status, sale: 0, pos: 0, neg: 0, inv: 0 };
        cells.set(id, cell);
      }

      if (fileType === "sale") {
        cell.sale += qty;
        if (qty > 0) cell.pos += qty;
        if (qty < 0) cell.neg += qty;
      } else {
        cell.inv += qty;
      }

      if (fileType === "inventory") {
        let st = state.get(barcode);
        if (!st) {
          st = { barcode, cat, type, status, stock: {} };
          state.set(barcode, st);
        }
        st.cat = cat;
        st.type = type;
        st.status = status;
        st.stock[branch] = qty;
      }
    }

    // Catalogue attributes are refreshed from every upload, sale sheets included,
    // so a product's category/type/status stays current even between inventory runs.
    if (fileType !== "inventory" && !state.has(barcode)) {
      state.set(barcode, { barcode, cat, type, status, stock: null });
    }
  }

  return { cells: [...cells.values()], state: [...state.values()] };
}

/**
 * Applies a folded upload. Rows for the affected dates are replaced rather than
 * incremented, so re-uploading the same day corrects it instead of doubling it.
 */
export async function commitUpload({ cells, state }) {
  const database = db();

  const dateKeys = [...new Set(cells.map((c) => c.dateKey))];
  if (dateKeys.length) {
    await database.collection(DAILY).deleteMany({ dateKey: { $in: dateKeys } });
    for (let i = 0; i < cells.length; i += 1000) {
      await database.collection(DAILY).insertMany(cells.slice(i, i + 1000), { ordered: false });
    }
  }

  if (state.length) {
    const ops = state.map((s) => {
      const set = { cat: s.cat, type: s.type, status: s.status };
      // Only inventory uploads carry stock levels; a sale sheet must not wipe them.
      if (s.stock) for (const [branch, qty] of Object.entries(s.stock)) set[`stock.${branch}`] = qty;
      return {
        updateOne: { filter: { _id: s.barcode }, update: { $set: set }, upsert: true },
      };
    });
    for (let i = 0; i < ops.length; i += 1000) {
      await database.collection(STATE).bulkWrite(ops.slice(i, i + 1000), { ordered: false });
    }
  }
}

/**
 * Rebuilds dashboard_counts from product_state.
 *
 * Reads product_state — small, flat documents — never `products`, so the cost
 * tracks how many products exist rather than how much history has accumulated.
 *
 * Emits a row per branch plus an "ALL" row. The ALL row is computed per product
 * rather than summed across branches, because these are distinct-product counts.
 */
export async function rebuildCounts(branches) {
  const database = db();

  const branchExpr = (branchList) => ({
    $let: {
      // Read the stock map once as {k, v} pairs. Looking branches up by
      // filtering this array — rather than $getField with a dynamic field name —
      // keeps the pipeline working on MongoDB 7.x, where $getField requires a
      // constant field. Atlas 8.0 accepts both; older clusters do not.
      vars: { arr: { $objectToArray: { $ifNull: ["$stock", {}] } } },
      in: {
        $concatArrays: [
          {
            $map: {
              input: branchList,
              as: "b",
              in: {
                $let: {
                  vars: {
                    v: {
                      $let: {
                        vars: {
                          hit: {
                            $first: {
                              $filter: {
                                input: "$$arr",
                                as: "e",
                                cond: { $eq: ["$$e.k", "$$b"] },
                              },
                            },
                          },
                        },
                        in: { $ifNull: ["$$hit.v", null] },
                      },
                    },
                  },
                  in: {
                    branch: "$$b",
                    // A missing reading is neither negative nor zero, and the
                    // guard must be a type check rather than a null check: an
                    // absent key yields undefined, which sorts BELOW null in
                    // BSON order, so both `undefined != null` and
                    // `undefined < 0` are true. A null-guard would count every
                    // unstocked product as negative stock.
                    neg: { $cond: [{ $and: [{ $isNumber: "$$v" }, { $lt: ["$$v", 0] }] }, 1, 0] },
                    zero: { $cond: [{ $and: [{ $isNumber: "$$v" }, { $eq: ["$$v", 0] }] }, 1, 0] },
                  },
                },
              },
            },
          },
          [
            {
              $let: {
                vars: { vals: { $map: { input: "$$arr", as: "e", in: "$$e.v" } } },
                in: {
                  branch: ALL,
                  neg: {
                    $cond: [
                      { $gt: [{ $size: { $filter: { input: "$$vals", cond: { $lt: ["$$this", 0] } } } }, 0] },
                      1,
                      0,
                    ],
                  },
                  zero: {
                    $cond: [
                      { $gt: [{ $size: { $filter: { input: "$$vals", cond: { $eq: ["$$this", 0] } } } }, 0] },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
          ],
        ],
      },
    },
  });

  await database.collection(COUNTS).deleteMany({});
  await database
    .collection(STATE)
    .aggregate(
      [
        {
          $project: {
            cat: { $ifNull: ["$cat", "UNCATEGORIZED"] },
            type: { $ifNull: ["$type", ""] },
            status: { $ifNull: ["$status", ""] },
            e: branchExpr(branches),
          },
        },
        { $unwind: "$e" },
        {
          $group: {
            _id: { b: "$e.branch", c: "$cat", t: "$type", s: "$status" },
            productCount: { $sum: 1 },
            negativeStockCount: { $sum: "$e.neg" },
            zeroStockCount: { $sum: "$e.zero" },
          },
        },
        {
          $addFields: {
            branch: "$_id.b",
            categoryName: "$_id.c",
            type: "$_id.t",
            sellingStatus: "$_id.s",
          },
        },
        { $merge: { into: COUNTS, whenMatched: "replace", whenNotMatched: "insert" } },
      ],
      { allowDiskUse: false }
    )
    .toArray();

  await database.collection(COUNTS).createIndex({ branch: 1, type: 1, sellingStatus: 1 });
}

const MONTH_INDEX = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/** Sort key for a year/month/day triple, so "latest" is well defined. */
function sortKeyExpr(yearVar, monthVar, dayVar) {
  return {
    $add: [
      { $multiply: [{ $convert: { input: yearVar, to: "int", onError: 0, onNull: 0 } }, 10000] },
      {
        $multiply: [
          {
            $switch: {
              branches: Object.entries(MONTH_INDEX).map(([abbr, idx]) => ({
                case: { $eq: [{ $arrayElemAt: [{ $split: [monthVar, "-"] }, 0] }, abbr] },
                then: idx,
              })),
              default: 0,
            },
          },
          100,
        ],
      },
      {
        $convert: {
          input: { $substrCP: [dayVar, 3, 12] }, // "DAY12" -> "12"
          to: "int",
          onError: 0,
          onNull: 0,
        },
      },
    ],
  };
}

/**
 * One-time migration: derives rollup_daily and product_state from the existing
 * `records` trees. Runs entirely server-side — the whole point is to avoid
 * pulling documents across the wire.
 *
 * After this, uploads maintain both incrementally and nothing scans `products`
 * again.
 */
export async function backfillFromProducts() {
  const database = db();

  const unwrap = [
    {
      $project: {
        cat: { $ifNull: ["$firstLevelCategory", ""] },
        type: { $ifNull: ["$type", ""] },
        status: { $ifNull: ["$sellingStatus", ""] },
        y: { $objectToArray: { $ifNull: ["$records", {}] } },
      },
    },
    { $unwind: "$y" },
    { $project: { cat: 1, type: 1, status: 1, yk: "$y.k", m: { $objectToArray: "$y.v" } } },
    { $unwind: "$m" },
    { $project: { cat: 1, type: 1, status: 1, yk: 1, mk: "$m.k", d: { $objectToArray: "$m.v" } } },
    { $unwind: "$d" },
    {
      $project: {
        cat: 1, type: 1, status: 1, yk: 1, mk: 1,
        dk: "$d.k",
        b: { $objectToArray: { $ifNull: ["$d.v.branches", {}] } },
      },
    },
    { $unwind: "$b" },
  ];

  await database.collection(DAILY).deleteMany({});
  await database.collection(DAILY).createIndex({ dateKey: 1 });

  await database
    .collection("products")
    .aggregate(
      [
        ...unwrap,
        {
          $group: {
            _id: {
              dateKey: { $concat: ["$yk", "|", "$mk", "|", "$dk"] },
              branch: "$b.k",
              cat: { $cond: [{ $eq: ["$cat", ""] }, "UNCATEGORIZED", "$cat"] },
              type: "$type",
              status: "$status",
            },
            sale: { $sum: { $ifNull: ["$b.v.sale", 0] } },
            pos: { $sum: { $cond: [{ $gt: ["$b.v.sale", 0] }, "$b.v.sale", 0] } },
            neg: { $sum: { $cond: [{ $lt: ["$b.v.sale", 0] }, "$b.v.sale", 0] } },
            inv: { $sum: { $ifNull: ["$b.v.inventory", 0] } },
          },
        },
        {
          $project: {
            _id: {
              $concat: ["$_id.dateKey", "|", "$_id.branch", "|", "$_id.cat", "|", "$_id.type", "|", "$_id.status"],
            },
            dateKey: "$_id.dateKey",
            branch: "$_id.branch",
            cat: "$_id.cat",
            type: "$_id.type",
            status: "$_id.status",
            sale: 1, pos: 1, neg: 1, inv: 1,
          },
        },
        { $merge: { into: DAILY, whenMatched: "replace", whenNotMatched: "insert" } },
      ],
      { allowDiskUse: false }
    )
    .toArray();

  // product_state: latest inventory reading per (barcode, branch).
  await database.collection(STATE).deleteMany({});
  await database
    .collection("products")
    .aggregate(
      [
        {
          $project: {
            _id: "$barcode",
            cat: {
              $cond: [
                { $eq: [{ $ifNull: ["$firstLevelCategory", ""] }, ""] },
                "UNCATEGORIZED",
                "$firstLevelCategory",
              ],
            },
            type: { $ifNull: ["$type", ""] },
            status: { $ifNull: ["$sellingStatus", ""] },
            // One {sortKey, readings} entry per day that carried inventory.
            days: {
              $reduce: {
                input: { $objectToArray: { $ifNull: ["$records", {}] } },
                initialValue: [],
                in: {
                  $let: {
                    vars: { year: "$$this", accY: "$$value" },
                    in: {
                      $reduce: {
                        input: { $objectToArray: { $ifNull: ["$$year.v", {}] } },
                        initialValue: "$$accY",
                        in: {
                          $let: {
                            vars: { month: "$$this", accM: "$$value" },
                            in: {
                              $reduce: {
                                input: { $objectToArray: { $ifNull: ["$$month.v", {}] } },
                                initialValue: "$$accM",
                                in: {
                                  $concatArrays: [
                                    "$$value",
                                    [
                                      {
                                        sk: sortKeyExpr("$$year.k", "$$month.k", "$$this.k"),
                                        readings: {
                                          $arrayToObject: {
                                            $map: {
                                              input: {
                                                $filter: {
                                                  input: {
                                                    $objectToArray: {
                                                      $ifNull: ["$$this.v.branches", {}],
                                                    },
                                                  },
                                                  as: "e",
                                                  // Only days that actually recorded stock.
                                                  cond: { $ne: [{ $type: "$$e.v.inventory" }, "missing"] },
                                                },
                                              },
                                              as: "e",
                                              in: { k: "$$e.k", v: "$$e.v.inventory" },
                                            },
                                          },
                                        },
                                      },
                                    ],
                                  ],
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        {
          $project: {
            cat: 1,
            type: 1,
            status: 1,
            // Oldest first, then merge so the newest reading wins per branch.
            stock: {
              $reduce: {
                input: { $sortArray: { input: "$days", sortBy: { sk: 1 } } },
                initialValue: {},
                in: { $mergeObjects: ["$$value", "$$this.readings"] },
              },
            },
          },
        },
        { $merge: { into: STATE, whenMatched: "replace", whenNotMatched: "insert" } },
      ],
      { allowDiskUse: false }
    )
    .toArray();

  return refreshDerived();
}

/** Branch codes seen in rollup_daily — the authoritative list, no sampling. */
export async function knownBranches() {
  const rows = await db().collection(DAILY).distinct("branch");
  return rows.filter(Boolean).sort();
}

/** Recomputes filter options and stores them for the dashboard to read. */
export async function rebuildMeta() {
  const database = db();
  const [branches, types, statuses, totalProducts] = await Promise.all([
    knownBranches(),
    database.collection(STATE).distinct("type"),
    database.collection(STATE).distinct("status"),
    database.collection(STATE).estimatedDocumentCount(),
  ]);

  await database.collection(META).replaceOne(
    { _id: "filters" },
    {
      _id: "filters",
      branches,
      types: types.filter(Boolean).sort(),
      statuses: statuses.filter(Boolean).sort(),
      totalProducts,
      builtAt: new Date(),
    },
    { upsert: true }
  );

  return { branches, types, statuses, totalProducts };
}

/**
 * Reads the dashboard.
 *
 * Additive metrics come from rollup_daily; for branch=ALL they are summed across
 * branch rows, which is exact. Distinct-product counts come from dashboard_counts,
 * which stores a purpose-built ALL row instead, because summing those across
 * branches would count one product many times.
 */
export async function readDashboard({ branch = ALL, type = ALL, sellingStatus = ALL } = {}) {
  const database = db();

  const dailyMatch = {};
  if (branch !== ALL) dailyMatch.branch = branch;
  if (type !== ALL) dailyMatch.type = type;
  if (sellingStatus !== ALL) dailyMatch.status = sellingStatus;

  const countsMatch = { branch };
  if (type !== ALL) countsMatch.type = type;
  if (sellingStatus !== ALL) countsMatch.sellingStatus = sellingStatus;

  const [sums, counts, meta] = await Promise.all([
    database
      .collection(DAILY)
      .aggregate([
        { $match: dailyMatch },
        {
          $group: {
            _id: "$cat",
            totalSales: { $sum: "$sale" },
            positiveSales: { $sum: "$pos" },
            negativeSales: { $sum: "$neg" },
            totalInventory: { $sum: "$inv" },
          },
        },
      ])
      .toArray(),
    database
      .collection(COUNTS)
      .aggregate([
        { $match: countsMatch },
        {
          $group: {
            _id: "$categoryName",
            productCount: { $sum: "$productCount" },
            negativeStockCount: { $sum: "$negativeStockCount" },
            zeroStockCount: { $sum: "$zeroStockCount" },
          },
        },
      ])
      .toArray(),
    database.collection(META).findOne({ _id: "filters" }),
  ]);

  const merged = new Map();
  const slot = (name) => {
    if (!merged.has(name)) {
      merged.set(name, {
        categoryName: name,
        totalSales: 0,
        positiveSales: 0,
        negativeSales: 0,
        totalInventory: 0,
        productCount: 0,
        negativeStockCount: 0,
        zeroStockCount: 0,
      });
    }
    return merged.get(name);
  };

  for (const s of sums) Object.assign(slot(s._id), { ...s, _id: undefined, categoryName: s._id });
  for (const c of counts) {
    const t = slot(c._id);
    t.productCount = c.productCount;
    t.negativeStockCount = c.negativeStockCount;
    t.zeroStockCount = c.zeroStockCount;
  }

  // _id breaks ties: many categories sit at zero sales, and without a tiebreaker
  // their card order changes between requests.
  const categories = [...merged.values()].sort(
    (a, b) => b.totalSales - a.totalSales || a.categoryName.localeCompare(b.categoryName)
  );

  const stats = categories.reduce(
    (acc, c) => ({
      totalProducts: acc.totalProducts + c.productCount,
      totalInventory: acc.totalInventory + c.totalInventory,
      totalSales: acc.totalSales + c.totalSales,
      positiveSales: acc.positiveSales + c.positiveSales,
      negativeSales: acc.negativeSales + c.negativeSales,
      negativeStock: acc.negativeStock + c.negativeStockCount,
      zeroStock: acc.zeroStock + c.zeroStockCount,
    }),
    {
      totalProducts: 0,
      totalInventory: 0,
      totalSales: 0,
      positiveSales: 0,
      negativeSales: 0,
      negativeStock: 0,
      zeroStock: 0,
    }
  );

  return {
    ready: Boolean(meta),
    stats,
    categories,
    filtersList: {
      branches: meta?.branches ?? [],
      types: meta?.types ?? [],
      statuses: meta?.statuses ?? [],
    },
  };
}

/** Everything an upload has to do to keep the dashboard current. */
export async function refreshDerived() {
  const { branches } = await rebuildMeta();
  await rebuildCounts(branches);
  await db().collection(DAILY).createIndex({ branch: 1, type: 1, sellingStatus: 1 });
  return { branches };
}
