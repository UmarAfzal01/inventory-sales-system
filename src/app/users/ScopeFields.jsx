"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MultiSelect from "./MultiSelect";

export const EMPTY_SCOPE = { branches: [], categories: [], subCategories: [], products: [] };

/**
 * The four access dimensions, each as All / Specific.
 *
 * The radio exists to make the stored meaning legible. An empty list means
 * unrestricted, which reads backwards on a bare set of checkboxes — nothing
 * ticked looks like "nothing allowed". "All" is simply the empty list, chosen
 * deliberately.
 */
function Dimension({ title, hint, isAll, onAllChange, children }) {
  return (
    <div className="py-5 border-t border-slate-100 first:border-t-0 first:pt-0">
      <h4 className="text-xs font-extrabold text-slate-500 uppercase tracking-wider">{title}</h4>
      {hint && <p className="text-[11px] text-slate-400 font-medium mt-1">{hint}</p>}
      <div className="flex flex-wrap gap-4 mt-3 mb-3">
        {[
          { value: true, label: `All ${title.toLowerCase()}` },
          { value: false, label: `Specific ${title.toLowerCase()}` },
        ].map((opt) => (
          <label key={String(opt.value)} className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              checked={isAll === opt.value}
              onChange={() => onAllChange(opt.value)}
              className="w-4 h-4 accent-blue-600"
            />
            <span className="text-xs font-bold text-slate-700">{opt.label}</span>
          </label>
        ))}
      </div>
      {!isAll && children}
    </div>
  );
}

export default function ScopeFields({ scope, onChange, options }) {
  const set = (key, values) => onChange({ ...scope, [key]: values });

  // "All" is not stored — it IS the empty list. Switching to Specific with
  // nothing chosen yet would silently mean "all", so the parent warns on save.
  const isAll = {
    branches: scope.branches.length === 0,
    categories: scope.categories.length === 0,
    subCategories: scope.subCategories.length === 0,
    products: scope.products.length === 0,
  };
  const [explicit, setExplicit] = useState({
    branches: !isAll.branches,
    categories: !isAll.categories,
    subCategories: !isAll.subCategories,
    products: !isAll.products,
  });

  const setMode = (key, all) => {
    setExplicit((e) => ({ ...e, [key]: !all }));
    if (all) set(key, []);
  };

  // Sub-category choices follow the chosen categories, so the list is not a
  // few hundred entries when only one category is in play.
  const subCategoryOptions = useMemo(() => {
    const all = options.categories ?? [];
    const relevant = scope.categories.length
      ? all.filter((c) => scope.categories.includes(c.category))
      : all;
    return [...new Set(relevant.flatMap((c) => c.subCategories))].sort();
  }, [options, scope.categories]);

  const categoryOptions = useMemo(
    () => (options.categories ?? []).map((c) => c.category),
    [options]
  );

  // --- products ---------------------------------------------------------
  const [names, setNames] = useState({});
  const asked = useRef(new Set());

  // Names for barcodes already stored against the user, so the chips read as
  // product names rather than digits.
  useEffect(() => {
    const missing = scope.products.filter((id) => !asked.current.has(id));
    if (!missing.length) return;
    missing.forEach((id) => asked.current.add(id));
    const params = new URLSearchParams();
    missing.slice(0, 200).forEach((id) => params.append("id", id));
    fetch(`/api/users/products?${params}`)
      .then((r) => r.json())
      .then((j) => {
        if (!j.success || !j.products.length) return;
        setNames((prev) => ({
          ...prev,
          ...Object.fromEntries(j.products.map((p) => [p.barcode, p.articleName])),
        }));
      })
      .catch(() => {});
  }, [scope.products]);

  // Confined to the categories and sub-categories chosen above. Searching the
  // whole catalogue let an ELECTRONICS scope pick a NESTLE water bottle, and
  // because the dimensions intersect that user would then see nothing at all.
  const searchProducts = useCallback(
    async (term) => {
      const params = new URLSearchParams();
      if (term) params.set("q", term);
      scope.categories.forEach((c) => params.append("category", c));
      scope.subCategories.forEach((sc) => params.append("subCategory", sc));
      const j = await fetch(`/api/users/products?${params}`).then((r) => r.json());
      if (!j.success) return [];
      return j.products.map((p) => ({
        value: p.barcode,
        label: p.articleName,
        hint: `${p.barcode} · ${p.subCategory || p.category}`,
      }));
    },
    [scope.categories, scope.subCategories]
  );

  return (
    <div>
      <Dimension
        title="Branches"
        isAll={!explicit.branches}
        onAllChange={(all) => setMode("branches", all)}
      >
        <MultiSelect
          options={options.branches ?? []}
          value={scope.branches}
          onChange={(v) => set("branches", v)}
          placeholder="Choose branches…"
        />
      </Dimension>

      <Dimension
        title="Categories"
        isAll={!explicit.categories}
        onAllChange={(all) => setMode("categories", all)}
      >
        <MultiSelect
          options={categoryOptions}
          value={scope.categories}
          onChange={(v) => set("categories", v)}
          placeholder="Choose categories…"
        />
      </Dimension>

      <Dimension
        title="Sub-categories"
        hint={
          scope.categories.length
            ? "Limited to the categories chosen above."
            : "Every sub-category, since no category is restricted."
        }
        isAll={!explicit.subCategories}
        onAllChange={(all) => setMode("subCategories", all)}
      >
        <MultiSelect
          options={subCategoryOptions}
          value={scope.subCategories}
          onChange={(v) => set("subCategories", v)}
          placeholder="Choose sub-categories…"
        />
      </Dimension>

      <Dimension
        title="Products"
        hint={
          scope.categories.length || scope.subCategories.length
            ? "Searches only within the categories chosen above."
            : "Searches the whole catalogue, since no category is restricted."
        }
        isAll={!explicit.products}
        onAllChange={(all) => setMode("products", all)}
      >
        <MultiSelect
          value={scope.products}
          onChange={(v, newLabels) => {
            if (newLabels) setNames((n) => ({ ...n, ...newLabels }));
            set("products", v);
          }}
          onSearch={searchProducts}
          labels={names}
          placeholder="Choose products…"
          searchPlaceholder="Search by name or barcode…"
          emptyHint="No products in the categories chosen above."
        />
      </Dimension>
    </div>
  );
}
