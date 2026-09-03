"use client";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * A dropdown that selects many values.
 *
 * Native <select multiple> is a scrolling list that requires ctrl-clicking and
 * shows no summary once closed, which is unusable at the sizes here — 38
 * categories, 754 sub-categories. This lists the chosen values on the field
 * itself, each removable without opening the panel, and searches when open.
 */
export default function MultiSelect({
  options,
  value,
  onChange,
  placeholder = "Select…",
  disabled,
  // Supplied instead of `options` when the list is too large to hold — it
  // receives the search term and resolves to [{ value, label, hint }].
  onSearch,
  // Labels for already-selected values, when the value is an opaque key such
  // as a barcode.
  labels = {},
  searchPlaceholder = "Search…",
  emptyHint = "Nothing matches.",
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState([]);
  const [searching, setSearching] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  // Debounced, and only when the caller supplies a search function.
  //
  // Runs on open with an empty term too, so the panel shows what is available
  // straight away — the same behaviour as the static lists. Typing then narrows
  // it. Without this the products field sat empty until something was typed,
  // which read as "there is nothing here".
  useEffect(() => {
    if (!onSearch || !open) return;
    const term = query.trim();
    let cancelled = false;
    const t = setTimeout(async () => {
      // Inside the timer, not the effect body — setting state synchronously in
      // an effect cascades an extra render.
      if (!cancelled) setSearching(true);
      try {
        const results = await onSearch(term);
        if (!cancelled) setRemote(results);
      } catch {
        if (!cancelled) setRemote([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, term ? 300 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, onSearch, open]);

  const normalise = (o) => (typeof o === "string" ? { value: o, label: o } : o);

  const filtered = useMemo(() => {
    if (onSearch) return remote.map(normalise);
    const q = query.trim().toLowerCase();
    const all = (options ?? []).map(normalise);
    return q ? all.filter((o) => o.label.toLowerCase().includes(q)) : all;
  }, [options, query, onSearch, remote]);

  const labelFor = (v) => labels[v] ?? v;

  const toggle = (option, label) =>
    onChange(
      value.includes(option) ? value.filter((v) => v !== option) : [...value, option],
      label ? { [option]: label } : undefined
    );

  // A count told you how many but not which, so the choice had to be reopened
  // to be read. The values themselves are shown instead, capped so that
  // selecting forty sub-categories cannot push the form off the screen.
  const VISIBLE = 8;
  const shown = value.slice(0, VISIBLE);
  const overflow = value.length - shown.length;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          setOpen((o) => {
            if (o) setQuery("");
            return !o;
          })
        }
        className={`w-full px-3 py-2.5 min-h-[3rem] rounded-2xl text-sm font-semibold flex items-center justify-between gap-2 border transition text-left ${
          disabled
            ? "bg-slate-50 border-slate-200 text-slate-400 cursor-not-allowed"
            : "bg-white/80 hover:bg-white border-slate-200/80 text-slate-800"
        }`}
      >
        {value.length === 0 ? (
          <span className="px-1 text-slate-400">{placeholder}</span>
        ) : (
          <span className="flex flex-wrap gap-1.5 min-w-0">
            {shown.map((v) => (
              <span
                key={v}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-blue-500/10 text-blue-800 text-[11px] font-bold max-w-[14rem]"
              >
                <span className="truncate">{labelFor(v)}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={`Remove ${v}`}
                  // Stops the click reaching the button and toggling the panel.
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(value.filter((x) => x !== v));
                  }}
                  className="hover:text-blue-950 cursor-pointer"
                >
                  ✕
                </span>
              </span>
            ))}
            {overflow > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-lg bg-slate-100 text-slate-600 text-[11px] font-bold">
                +{overflow} more
              </span>
            )}
          </span>
        )}
        <svg
          className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && !disabled && (
        <div className="absolute z-50 top-full left-0 right-0 mt-2 bg-white border border-slate-200 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.15)] overflow-hidden">
          {(onSearch || (options ?? []).length > 8) && (
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full px-4 py-2.5 text-xs font-semibold border-b border-slate-100 focus:outline-none"
            />
          )}
          <div className="max-h-56 overflow-y-auto p-1.5 space-y-0.5">
            {filtered.length === 0 && (
              <p className="px-3 py-3 text-xs font-semibold text-slate-400">
                {searching ? "Loading…" : query.trim() ? "Nothing matches." : emptyHint}
              </p>
            )}
            {filtered.map((option) => {
              const checked = value.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => toggle(option.value, option.label)}
                  className={`w-full text-left px-3 py-2 rounded-xl text-xs font-semibold flex items-center gap-2.5 transition ${
                    checked ? "bg-blue-600 text-white" : "text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  <span
                    className={`w-4 h-4 rounded-md border flex items-center justify-center shrink-0 ${
                      checked ? "bg-white border-white text-blue-600" : "border-slate-300"
                    }`}
                  >
                    {checked && (
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="3.5" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </span>
                  <span className="truncate">
                    {option.label}
                    {option.hint && (
                      <span className={`ml-2 font-medium ${checked ? "text-blue-100" : "text-slate-400"}`}>
                        {option.hint}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          {value.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="w-full px-4 py-2.5 text-xs font-bold text-slate-500 hover:text-slate-800 border-t border-slate-100"
            >
              Clear selection
            </button>
          )}
        </div>
      )}
    </div>
  );
}
