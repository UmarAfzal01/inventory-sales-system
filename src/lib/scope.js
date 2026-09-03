/**
 * Per-user data scoping.
 *
 * A user may be restricted to particular branches, categories, sub-categories
 * and products. The four dimensions INTERSECT: branches [BRL] plus categories
 * [GROCERIES] means GROCERIES in BRL, nothing else. An empty dimension means
 * unrestricted on that dimension, not "nothing" — so a brand new user with no
 * scope set sees everything, and each list the admin adds only ever narrows.
 *
 * Scope is resolved from the database record on every request. It is never
 * accepted from the client, and never applied in the browser: the filtering
 * happens inside the queries, so out-of-scope rows are not fetched at all.
 */

// Inlined rather than imported from warehouse.js, which imports this module —
// the cycle resolved at runtime but left ALL undefined during module init.
const ALL = "ALL";

/** null on a dimension means "no restriction". */
export function effectiveScope(user) {
  // The single admin sees everything, whatever is stored against them.
  if (!user || user.role === "admin") {
    return { branches: null, categories: null, subCategories: null, products: null };
  }
  const s = user.scope ?? {};
  const list = (v) => (Array.isArray(v) && v.length ? v : null);
  return {
    branches: list(s.branches),
    categories: list(s.categories),
    subCategories: list(s.subCategories),
    products: list(s.products),
  };
}

export const UNRESTRICTED = {
  branches: null,
  categories: null,
  subCategories: null,
  products: null,
};

/**
 * Resolves a requested value against an allow-list.
 *
 * Returns null for "no constraint", a one-element array for a specific pick,
 * or an EMPTY array when the request falls outside the scope — which callers
 * must treat as "no rows", not as "no filter". Conflating those two is how a
 * scoping bug turns into a data leak.
 */
export function resolveAllowed(requested, allowed) {
  const isAll = requested === ALL || requested === null || requested === undefined;
  if (isAll) return allowed ? [...allowed] : null;
  if (!allowed) return [requested];
  return allowed.includes(requested) ? [requested] : [];
}

/** Turns a resolved list into a Mongo condition, or undefined for no constraint. */
export function condition(values) {
  if (values === null) return undefined;
  if (values.length === 1) return values[0];
  return { $in: values };
}

/** True when any dimension resolved to "outside your scope", so the answer is empty. */
export const isEmptyScope = (...lists) => lists.some((l) => Array.isArray(l) && l.length === 0);

/** What the admin stores. Unknown keys are dropped rather than persisted. */
export function sanitiseScope(input) {
  const clean = (v) =>
    Array.isArray(v)
      ? [...new Set(v.map((x) => String(x ?? "").trim()).filter(Boolean))]
      : [];
  return {
    branches: clean(input?.branches),
    categories: clean(input?.categories),
    subCategories: clean(input?.subCategories),
    products: clean(input?.products),
  };
}

/** A one-line summary for the users table. */
export function describeScope(scope) {
  const parts = [];
  const n = (a, singular) =>
    a?.length ? `${a.length} ${singular}${a.length === 1 ? "" : "s"}` : null;
  const b = n(scope?.branches, "branch");
  parts.push(b ? b.replace("branchs", "branches") : null);
  parts.push(n(scope?.categories, "category")?.replace("categorys", "categories"));
  parts.push(n(scope?.subCategories, "sub-category")?.replace("sub-categorys", "sub-categories"));
  parts.push(n(scope?.products, "product"));
  const set = parts.filter(Boolean);
  return set.length ? set.join(", ") : "Full access";
}
