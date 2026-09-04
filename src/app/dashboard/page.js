"use client";
import { useState, useEffect, useRef } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { formatAmount, exactAmount } from "@/lib/format";

// Names the branch grid after whatever metric card is active, so a card
// showing two of eleven branches says why.
// Hidden on /sales, but a stock filter could still arrive in the URL and
// silently empty the page with nothing on screen to explain it. At module scope
// so it is not a fresh array on every render.
const STOCK_METRICS = ["negativeStock", "zeroStock", "zeroSales"];

const BRANCH_HEADING = {
  totalSales: "Branches with sales",
  positiveSales: "Branches with positive sales",
  negativeSales: "Branches with negative sales",
  negativeStock: "Branches with negative stock",
  zeroStock: "Branches with zero stock",
  zeroSales: "Branches in stock, nothing sold",
};

export default function DashboardPage() {
  const router = useRouter();
  const pathname = usePathname();
  // /sales renders this same component with the money metrics instead of the
  // stock ones. Everything else — drill-down, filters, dates, scoping, search —
  // is identical, so the two pages share one implementation.
  const isSales = (pathname || "").startsWith("/sales");
  const searchParams = useSearchParams();

  const urlBranch = searchParams.get("branch");
  const urlType = searchParams.get("type");
  const urlStatus = searchParams.get("sellingStatus");
  const urlMetric = searchParams.get("metricFilter");
  const urlFrom = searchParams.get("from");
  const urlTo = searchParams.get("to");
  const urlCategory = searchParams.get("category"); // Drill-down parent category parameter

  const [loading, setLoading] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [stats, setStats] = useState({
    totalSales: 0,
    positiveSales: 0,
    negativeSales: 0,
    negativeStock: 0,
    zeroStock: 0,
  });
  const [categoriesData, setCategoriesData] = useState([]);
  const [filters, setFilters] = useState({
    branches: [],
    types: [],
    statuses: [],
  });

  // Initialize states from URL query params
  const [selectedBranch, setSelectedBranch] = useState(urlBranch || "ALL");
  const [selectedType, setSelectedType] = useState(urlType || "ALL");
  const [selectedStatus, setSelectedStatus] = useState(urlStatus || "ALL");
  const [activeMetricFilter, setActiveMetricFilter] = useState(
    urlMetric || null,
  );
  const [fromDate, setFromDate] = useState(urlFrom || "");
  const [toDate, setToDate] = useState(urlTo || "");
  const [selectedCategory, setSelectedCategory] = useState(urlCategory || null);
  // Level 3: the products inside one sub-category.
  const [selectedSubCategory, setSelectedSubCategory] = useState(
    searchParams.get("subCategory"),
  );
  const [productData, setProductData] = useState(null);
  const [productPage, setProductPage] = useState(1);
  // Level 3 searches products server-side; level 1/2 filter their cards in the
  // browser. Keeping the terms separate stops one clobbering the other.
  const [productSearch, setProductSearch] = useState("");
  const [productSearchDebounced, setProductSearchDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      setProductSearchDebounced(productSearch);
      setProductPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [productSearch]);

  // Category search state
  const [categorySearchQuery, setCategorySearchQuery] = useState("");

  // Sync state if URL query parameters change externally
  useEffect(() => {
    setSelectedBranch(urlBranch || "ALL");
    setSelectedType(urlType || "ALL");
    setSelectedStatus(urlStatus || "ALL");
    setActiveMetricFilter(urlMetric || null);
    setFromDate(urlFrom || "");
    setToDate(urlTo || "");
    setSelectedCategory(urlCategory || null);
    setSelectedSubCategory(searchParams.get("subCategory"));
  }, [
    urlBranch,
    urlType,
    urlStatus,
    urlMetric,
    urlFrom,
    urlTo,
    urlCategory,
    searchParams,
  ]);

  // Update URL parameters helper including category drill-down
  const updateUrlParams = (
    newBranch,
    newType,
    newStatus,
    newMetric,
    newFrom,
    newTo,
    newCategory,
  ) => {
    const params = new URLSearchParams(searchParams.toString());

    if (newBranch && newBranch !== "ALL") params.set("branch", newBranch);
    else params.delete("branch");

    if (newType && newType !== "ALL") params.set("type", newType);
    else params.delete("type");

    if (newStatus && newStatus !== "ALL")
      params.set("sellingStatus", newStatus);
    else params.delete("sellingStatus");

    if (newMetric) params.set("metricFilter", newMetric);
    else params.delete("metricFilter");

    if (newFrom) params.set("from", newFrom);
    else params.delete("from");

    if (newTo) params.set("to", newTo);
    else params.delete("to");

    if (newCategory) params.set("category", newCategory);
    else params.delete("category");

    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  // Dropdown open states
  const [branchOpen, setBranchOpen] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);

  // Refs for outside click handling
  const branchRef = useRef(null);
  const typeRef = useRef(null);
  const statusRef = useRef(null);

  const [setupNeeded, setSetupNeeded] = useState(false);

  const [dateFiltered, setDateFiltered] = useState(false);
  const [stockDate, setStockDate] = useState(null);
  const [stockAvailable, setStockAvailable] = useState(true);
  const [dateBounds, setDateBounds] = useState({
    minDate: null,
    maxDate: null,
  });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const onDataUpdated = () => setReloadKey((k) => k + 1);
    window.addEventListener("inventory:data-updated", onDataUpdated);
    return () =>
      window.removeEventListener("inventory:data-updated", onDataUpdated);
  }, []);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (branchRef.current && !branchRef.current.contains(e.target))
        setBranchOpen(false);
      if (typeRef.current && !typeRef.current.contains(e.target))
        setTypeOpen(false);
      if (statusRef.current && !statusRef.current.contains(e.target))
        setStatusOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      setLoading(true);
      try {
        const qp = new URLSearchParams({
          branch: selectedBranch,
          type: selectedType,
          sellingStatus: selectedStatus,
        });
        if (fromDate) qp.set("from", fromDate);
        if (toDate) qp.set("to", toDate);
        if (selectedCategory) qp.set("category", selectedCategory);
        if (selectedCategory && selectedSubCategory !== null) {
          qp.set("subCategory", selectedSubCategory);
        }
        // A search term applies at every level — scoped to wherever the user has
        // drilled to, global from the top. Sending it only at level 3 made the
        // global search unreachable.
        if (productSearchDebounced) qp.set("q", productSearchDebounced);
        if (productSearchDebounced || selectedSubCategory !== null) {
          qp.set("page", String(productPage));
        }

        // /sales has a single, non-clickable metric, so a filter arriving in the
        // URL would narrow the page with no control on screen to undo it.
        if (activeMetricFilter && !isSales) {
          qp.set("metricFilter", activeMetricFilter);
        }

        const res = await fetch(`/api/dashboard?${qp.toString()}`, {
          signal: controller.signal,
        }).then((r) => r.json());

        if (res.needsUpload) {
          setSetupNeeded(true);
          return;
        }
        if (!res.success)
          throw new Error(res.error || "Dashboard request failed");

        // Level 3 returns products rather than category cards.
        if (res.level === "products") {
          setProductData(res);
          // Level 3 returns its own totals; without this the metric cards kept
          // showing the level-2 figures while the list below had drilled deeper.
          if (res.stats) setStats(res.stats);
          setStockDate(res.stockDate ?? null);
          setStockAvailable(Boolean(res.stockDate));
          setSetupNeeded(false);
          return;
        }
        setProductData(null);

        setSetupNeeded(false);
        setStats(res.stats);
        setFilters(res.filtersList);
        setCategoriesData(res.categories);
        setDateFiltered(Boolean(res.dateFiltered));
        setStockDate(res.stockDate ?? null);
        setStockAvailable(res.stockAvailable !== false);
        setDateBounds({
          minDate: res.filtersList?.minDate ?? null,
          maxDate: res.filtersList?.maxDate ?? null,
        });
      } catch (err) {
        if (err.name === "AbortError") return;
        console.error("Dashboard fetch error:", err);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setHasLoadedOnce(true);
        }
      }
    };

    load();
    return () => controller.abort();
  }, [
    selectedBranch,
    selectedType,
    selectedStatus,
    fromDate,
    toDate,
    selectedCategory,
    selectedSubCategory,
    productPage,
    productSearchDebounced,
    activeMetricFilter,
    reloadKey,
      isSales,
  ]);

  // null means "not known" — no stock snapshot covers the selected range — and
  // must not render as 0, which reads as a counted zero. Only undefined, i.e. a
  // field the response genuinely omitted, falls back to 0.
  const formatNumber = (val) => {
    if (loading && !hasLoadedOnce) return "—";
    if (val === null) return "—";
    if (val === undefined) return "0";
    // Quantities can be fractional (weighed goods), but two decimals on a
    // seven-figure total is noise that also costs three characters of width.
    // Precision is kept where it can still be read.
    return val.toLocaleString(undefined, {
      maximumFractionDigits: Math.abs(val) >= 1000 ? 0 : 2,
    });
  };

  // Which branches a product card should list.
  //
  // With a metric card active, showing all eleven buries the answer: filtering
  // by zero stock and then having to scan the row for the two branches that
  // actually read zero defeats the filter. These mirror the server-side
  // predicates so a card never disagrees with the list it came from.
  //
  // A branch missing from branchStock has no non-zero reading, which is zero —
  // inventory_state stores only non-zero rows.
  const branchesForMetric = (p) => {
    const all = productData?.branches ?? [];
    const stock = (b) => p.branchStock?.[b] ?? 0;
    const sold = (b) => p.branchSales?.[b] ?? 0;
    switch (activeMetricFilter) {
      case "totalSales":
        return all.filter((b) => sold(b) !== 0);
      case "positiveSales":
        return all.filter((b) => sold(b) > 0);
      case "negativeSales":
        return all.filter((b) => sold(b) < 0);
      case "negativeStock":
        return all.filter((b) => stock(b) < 0);
      case "zeroStock":
        return all.filter((b) => stock(b) === 0);
      case "zeroSales":
        // Dead stock is per branch too: something on that shelf, nothing sold.
        return all.filter((b) => stock(b) > 0 && sold(b) === 0);
      default:
        return all;
    }
  };

  // Metric values run from "—" to "6,708,079.15". At a fixed 2xl the long ones
  // overflowed their card, so the size steps down as the string grows.
  const metricValueClass = (val) => {
    const len = formatNumber(val).length;
    if (len > 11) return "text-base";
    if (len > 8) return "text-xl";
    return "text-2xl";
  };

  const handleMetricCardClick = (metricKey) => {
    const newMetric = activeMetricFilter === metricKey ? null : metricKey;
    setActiveMetricFilter(newMetric);
    updateUrlParams(
      selectedBranch,
      selectedType,
      selectedStatus,
      newMetric,
      fromDate,
      toDate,
      selectedCategory,
    );
  };

  // Handle clicking a first level category card to drill down
  const handleCategoryClick = (categoryName) => {
    setSelectedCategory(categoryName);
    setCategorySearchQuery(""); // reset search on category change
    updateUrlParams(
      selectedBranch,
      selectedType,
      selectedStatus,
      activeMetricFilter,
      fromDate,
      toDate,
      categoryName,
    );
  };

  // Handle going back from last level categories to first level view
  const handleBackToFirstLevel = () => {
    setSelectedCategory(null);
    setSelectedSubCategory(null);
    setProductData(null);
    setProductPage(1);
    setCategorySearchQuery("");
    const params = new URLSearchParams(searchParams.toString());
    params.delete("category");
    params.delete("subCategory");
    params.delete("page");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  // Level 2 -> level 3: the products inside a sub-category.
  const handleSubCategoryClick = (subName) => {
    setSelectedSubCategory(subName);
    setProductPage(1);
    setProductSearch("");
    setProductSearchDebounced("");
    const params = new URLSearchParams(searchParams.toString());
    params.set("category", selectedCategory);
    params.set("subCategory", subName);
    params.delete("page");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  // Level 3 -> level 2.
  const handleBackToSubCategories = () => {
    setSelectedSubCategory(null);
    setProductData(null);
    setProductPage(1);
    setProductSearch("");
    setProductSearchDebounced("");
    const params = new URLSearchParams(searchParams.toString());
    params.delete("subCategory");
    params.delete("page");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  // Filter categories based on the search query input
  const filteredCategories = categoriesData.filter((cat) =>
    cat.categoryName.toLowerCase().includes(categorySearchQuery.toLowerCase()),
  );

  return (
    <div className="min-h-screen bg-transparent text-slate-900 relative pb-16 selection:bg-blue-600 selection:text-white">
      {/* Top Animated Loading Bar */}
      {loading && (
        <div className="fixed top-0 left-0 right-0 z-50 h-1.5 bg-white/20 overflow-hidden backdrop-blur-md">
          <div className="w-full h-full bg-gradient-to-r from-blue-600 via-indigo-600 to-teal-500 animate-pulse transition-all duration-300"></div>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-10">
        {/* Header Section */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 drop-shadow-sm">
              {isSales ? "Sales Overview" : "Enterprise Analytics"}{" "}
              {selectedBranch !== "ALL" && (
                <span className="text-blue-600">— {selectedBranch}</span>
              )}
            </h1>
            <p className="text-sm text-slate-500 font-medium mt-1">
              {isSales
                ? "Revenue by category, sub-category and product across every branch."
                : "Real-time multi-branch inventory tracking, sales performance, and catalog overview."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold bg-emerald-500/10 text-emerald-700 border border-emerald-500/20 shadow-sm backdrop-blur-md">
              <span
                className={`w-2 h-2 rounded-full ${loading ? "bg-amber-500" : "bg-emerald-500 animate-ping shadow-[0_0_8px_rgba(16,185,129,0.8)]"}`}
              ></span>
              {loading ? "Updating Metrics..." : "Live Sync Active"}
            </span>
          </div>
        </div>

        {/* Filters Bar */}
        <div className="relative z-30 grid grid-cols-1 md:grid-cols-3 gap-5 bg-white/70 backdrop-blur-3xl p-6 rounded-3xl border border-white/80 shadow-[0_20px_50px_rgba(0,0,0,0.05)] mb-8">
          <div className="absolute -top-10 -right-10 w-32 h-32 bg-blue-400/10 rounded-full blur-2xl pointer-events-none"></div>

          {/* Global product search. Works from any level: scoped to wherever
              the user has drilled to, across the whole catalogue from the top.
              Spans the full grid so it reads as the widest filter, above the
              three that narrow it. */}
          <div className="md:col-span-3">
            <label className="block text-xs font-extrabold text-slate-400 uppercase tracking-wider mb-2">
              Product Search
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 flex items-center pl-4 pointer-events-none text-slate-400">
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2.5"
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              </span>
              <input
                type="text"
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                placeholder="Search any product by name or barcode..."
                className="w-full pl-11 pr-10 py-3 bg-white/80 hover:bg-white border border-slate-200/80 rounded-2xl text-sm font-semibold text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all shadow-sm backdrop-blur-md"
              />
              {productSearch && (
                <button
                  type="button"
                  onClick={() => setProductSearch("")}
                  className="absolute inset-y-0 right-0 pr-4 flex items-center text-slate-400 hover:text-slate-600 text-xs font-bold"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Branch Location Dropdown */}
          <div className="relative" ref={branchRef}>
            <label className="block text-xs font-extrabold text-slate-400 uppercase tracking-wider mb-2">
              Branch Location
            </label>
            <button
              type="button"
              onClick={() => {
                setBranchOpen(!branchOpen);
                setTypeOpen(false);
                setStatusOpen(false);
              }}
              className="w-full px-4 py-3 bg-white/80 hover:bg-white border border-slate-200/80 rounded-2xl text-sm text-slate-800 font-semibold flex items-center justify-between transition-all shadow-sm backdrop-blur-md"
            >
              <span className="truncate">
                {selectedBranch === "ALL" ? "All Branches" : selectedBranch}
              </span>
              <svg
                className={`w-4 h-4 text-slate-400 transition-transform duration-200 shrink-0 ${branchOpen ? "rotate-180" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2.5"
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>

            {branchOpen && (
              <div className="absolute top-full left-0 right-0 mt-2 bg-white/95 backdrop-blur-3xl border border-slate-200/80 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.15)] z-50 overflow-hidden p-1.5 space-y-1 max-h-60 overflow-y-auto">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedBranch("ALL");
                    setBranchOpen(false);
                    updateUrlParams(
                      "ALL",
                      selectedType,
                      selectedStatus,
                      activeMetricFilter,
                      fromDate,
                      toDate,
                      selectedCategory,
                    );
                  }}
                  className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                    selectedBranch === "ALL"
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  All Branches
                </button>
                {filters.branches.map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => {
                      setSelectedBranch(b);
                      setBranchOpen(false);
                      updateUrlParams(
                        b,
                        selectedType,
                        selectedStatus,
                        activeMetricFilter,
                        fromDate,
                        toDate,
                        selectedCategory,
                      );
                    }}
                    className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all truncate ${
                      selectedBranch === b
                        ? "bg-blue-600 text-white shadow-sm"
                        : "text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {b}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Product Type Dropdown */}
          <div className="relative" ref={typeRef}>
            <label className="block text-xs font-extrabold text-slate-400 uppercase tracking-wider mb-2">
              Product Type
            </label>
            <button
              type="button"
              onClick={() => {
                setTypeOpen(!typeOpen);
                setBranchOpen(false);
                setStatusOpen(false);
              }}
              className="w-full px-4 py-3 bg-white/80 hover:bg-white border border-slate-200/80 rounded-2xl text-sm text-slate-800 font-semibold flex items-center justify-between transition-all shadow-sm backdrop-blur-md"
            >
              <span className="truncate">
                {selectedType === "ALL" ? "All Types" : selectedType}
              </span>
              <svg
                className={`w-4 h-4 text-slate-400 transition-transform duration-200 shrink-0 ${typeOpen ? "rotate-180" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2.5"
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>

            {typeOpen && (
              <div className="absolute top-full left-0 right-0 mt-2 bg-white/95 backdrop-blur-3xl border border-slate-200/80 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.15)] z-50 overflow-hidden p-1.5 space-y-1 max-h-60 overflow-y-auto">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedType("ALL");
                    setTypeOpen(false);
                    updateUrlParams(
                      selectedBranch,
                      "ALL",
                      selectedStatus,
                      activeMetricFilter,
                      fromDate,
                      toDate,
                      selectedCategory,
                    );
                  }}
                  className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                    selectedType === "ALL"
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  All Types
                </button>
                {filters.types.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      setSelectedType(t);
                      setTypeOpen(false);
                      updateUrlParams(
                        selectedBranch,
                        t,
                        selectedStatus,
                        activeMetricFilter,
                        fromDate,
                        toDate,
                        selectedCategory,
                      );
                    }}
                    className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all truncate ${
                      selectedType === t
                        ? "bg-blue-600 text-white shadow-sm"
                        : "text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Selling Status Dropdown */}
          <div className="relative" ref={statusRef}>
            <label className="block text-xs font-extrabold text-slate-400 uppercase tracking-wider mb-2">
              Selling Status
            </label>
            <button
              type="button"
              onClick={() => {
                setStatusOpen(!statusOpen);
                setBranchOpen(false);
                setTypeOpen(false);
              }}
              className="w-full px-4 py-3 bg-white/80 hover:bg-white border border-slate-200/80 rounded-2xl text-sm text-slate-800 font-semibold flex items-center justify-between transition-all shadow-sm backdrop-blur-md"
            >
              <span className="truncate">
                {selectedStatus === "ALL" ? "All Statuses" : selectedStatus}
              </span>
              <svg
                className={`w-4 h-4 text-slate-400 transition-transform duration-200 shrink-0 ${statusOpen ? "rotate-180" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2.5"
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>

            {statusOpen && (
              <div className="absolute top-full left-0 right-0 mt-2 bg-white/95 backdrop-blur-3xl border border-slate-200/80 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.15)] z-50 overflow-hidden p-1.5 space-y-1 max-h-60 overflow-y-auto">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedStatus("ALL");
                    setStatusOpen(false);
                    updateUrlParams(
                      selectedBranch,
                      selectedType,
                      "ALL",
                      activeMetricFilter,
                      fromDate,
                      toDate,
                      selectedCategory,
                    );
                  }}
                  className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                    selectedStatus === "ALL"
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  All Statuses
                </button>
                {filters.statuses.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      setSelectedStatus(s);
                      setStatusOpen(false);
                      updateUrlParams(
                        selectedBranch,
                        selectedType,
                        s,
                        activeMetricFilter,
                        fromDate,
                        toDate,
                        selectedCategory,
                      );
                    }}
                    className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all truncate ${
                      selectedStatus === s
                        ? "bg-blue-600 text-white shadow-sm"
                        : "text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Date range section synced with URL search params */}
        <div className="mb-8 bg-white/70 backdrop-blur-xl border border-slate-200 rounded-3xl p-5">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label
                htmlFor="fromDate"
                className="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1.5"
              >
                From
              </label>
              <input
                id="fromDate"
                type="date"
                value={fromDate}
                max={toDate || undefined}
                onChange={(e) => {
                  const val = e.target.value;
                  setFromDate(val);
                  updateUrlParams(
                    selectedBranch,
                    selectedType,
                    selectedStatus,
                    activeMetricFilter,
                    val,
                    toDate,
                    selectedCategory,
                  );
                }}
                className="bg-white border border-slate-300 text-slate-800 text-sm rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label
                htmlFor="toDate"
                className="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-1.5"
              >
                To
              </label>
              <input
                id="toDate"
                type="date"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => {
                  const val = e.target.value;
                  setToDate(val);
                  updateUrlParams(
                    selectedBranch,
                    selectedType,
                    selectedStatus,
                    activeMetricFilter,
                    fromDate,
                    val,
                    selectedCategory,
                  );
                }}
                className="bg-white border border-slate-300 text-slate-800 text-sm rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              {[
                { label: "Last 7 days", days: 7 },
                { label: "Last 30 days", days: 30 },
                // Calendar months, not 30-day multiples: "2 months" should land
                // on the same day-of-month, which setUTCMonth handles including
                // the short-month rollover.
                { label: "Last 2 months", months: 2 },
                { label: "Last 3 months", months: 3 },
                { label: "Last 6 months", months: 6 },
                { label: "Last 1 year", months: 12 },
              ].map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    const end = dateBounds.maxDate
                      ? new Date(dateBounds.maxDate)
                      : new Date();
                    const start = new Date(end);
                    if (p.months) start.setUTCMonth(start.getUTCMonth() - p.months);
                    else start.setUTCDate(start.getUTCDate() - (p.days - 1));
                    const startStr = start.toISOString().slice(0, 10);
                    const endStr = end.toISOString().slice(0, 10);

                    setFromDate(startStr);
                    setToDate(endStr);
                    updateUrlParams(
                      selectedBranch,
                      selectedType,
                      selectedStatus,
                      activeMetricFilter,
                      startStr,
                      endStr,
                      selectedCategory,
                    );
                  }}
                  className="px-3 py-2 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 transition"
                >
                  {p.label}
                </button>
              ))}
              {(fromDate || toDate) && (
                <button
                  type="button"
                  onClick={() => {
                    setFromDate("");
                    setToDate("");
                    updateUrlParams(
                      selectedBranch,
                      selectedType,
                      selectedStatus,
                      activeMetricFilter,
                      "",
                      "",
                      selectedCategory,
                    );
                  }}
                  className="px-3 py-2 rounded-xl text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 transition"
                >
                  Clear dates ✕
                </button>
              )}
            </div>
          </div>

          {!isSales &&
            dateFiltered &&
            (stockAvailable ? (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mt-3">
                Sales reflect the selected dates. Stock as at {stockDate}.
              </p>
            ) : (
              <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2 mt-3">
                Sales reflect the selected dates. No stock count exists on or
                before {toDate || "this date"}, so stock figures are not shown.
              </p>
            ))}
        </div>

        {/* Sales & Stock Performance Section — stock omitted on /sales */}
        <div className="mb-10">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-extrabold tracking-tight text-slate-900 drop-shadow-sm">
              Performance Metrics Overview
            </h2>
            {activeMetricFilter && (
              <button
                onClick={() => handleMetricCardClick(activeMetricFilter)}
                className="text-xs font-bold text-blue-600 hover:underline bg-blue-50 px-3 py-1 rounded-full border border-blue-200"
              >
                Clear Metric Filter (Showing All) ✕
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
            {/* Sales Amount — revenue, admin-only, so it is absent from the
                response entirely for anyone else. */}
            {isSales && (
              <div className="backdrop-blur-3xl p-5 rounded-3xl border bg-gradient-to-br from-emerald-500/10 via-teal-500/5 to-white/40 border-emerald-500/20">
                <h3 className="text-xs font-extrabold uppercase tracking-wider text-emerald-700">
                  Sales Amount
                </h3>
                <p
                  title={exactAmount(stats.amount)}
                  className="text-2xl font-black mt-2 tabular-nums leading-tight whitespace-nowrap text-emerald-700"
                >
                  {formatAmount(stats.amount)}
                </p>
              </div>
            )}

            {!isSales && (
              <>
            {/* Net Sales Card */}
            <div
              onClick={() => handleMetricCardClick("totalSales")}
              className={`cursor-pointer backdrop-blur-3xl p-5 rounded-3xl border transition-all ${
                activeMetricFilter === "totalSales"
                  ? "bg-indigo-600 text-white shadow-lg ring-2 ring-indigo-400"
                  : "bg-gradient-to-br from-indigo-500/10 via-blue-500/5 to-white/40 border-indigo-500/20 hover:border-indigo-500/50"
              }`}
            >
              <h3
                className={`text-xs font-extrabold uppercase tracking-wider ${activeMetricFilter === "totalSales" ? "text-indigo-100" : "text-indigo-700"}`}
              >
                {isSales ? "Units Sold (Net)" : "Total Sales (Net)"}
              </h3>
              <p
                className={`${metricValueClass(stats.totalSales)} font-black mt-2 tabular-nums leading-tight whitespace-nowrap ${activeMetricFilter === "totalSales" ? "text-white" : "text-slate-900"}`}
              >
                {formatNumber(stats.totalSales)}
              </p>
              <div
                className={`mt-2 text-[11px] font-semibold ${activeMetricFilter === "totalSales" ? "text-indigo-200" : "text-indigo-600"}`}
              >
                Click to filter categories
              </div>
            </div>

            {/* Positive Sales Card */}
            <div
              onClick={() => handleMetricCardClick("positiveSales")}
              className={`cursor-pointer backdrop-blur-3xl p-5 rounded-3xl border transition-all ${
                activeMetricFilter === "positiveSales"
                  ? "bg-teal-600 text-white shadow-lg ring-2 ring-teal-400"
                  : "bg-gradient-to-br from-teal-500/10 via-emerald-500/5 to-white/40 border-teal-500/20 hover:border-teal-500/50"
              }`}
            >
              <h3
                className={`text-xs font-extrabold uppercase tracking-wider ${activeMetricFilter === "positiveSales" ? "text-teal-100" : "text-teal-700"}`}
              >
                {isSales ? "Units Sold" : "Positive Sales"}
              </h3>
              <p
                className={`${metricValueClass(stats.positiveSales)} font-black mt-2 tabular-nums leading-tight whitespace-nowrap ${activeMetricFilter === "positiveSales" ? "text-white" : "text-teal-700"}`}
              >
                {formatNumber(stats.positiveSales)}
              </p>
              <div
                className={`mt-2 text-[11px] font-semibold ${activeMetricFilter === "positiveSales" ? "text-teal-200" : "text-teal-600"}`}
              >
                Click to filter categories
              </div>
            </div>

            {/* Negative Sales Card */}
            <div
              onClick={() => handleMetricCardClick("negativeSales")}
              className={`cursor-pointer backdrop-blur-3xl p-5 rounded-3xl border transition-all ${
                activeMetricFilter === "negativeSales"
                  ? "bg-rose-600 text-white shadow-lg ring-2 ring-rose-400"
                  : "bg-gradient-to-br from-rose-500/10 via-orange-500/5 to-white/40 border-rose-500/20 hover:border-rose-500/50"
              }`}
            >
              <h3
                className={`text-xs font-extrabold uppercase tracking-wider ${activeMetricFilter === "negativeSales" ? "text-rose-100" : "text-rose-700"}`}
              >
                {isSales ? "Units Returned" : "Negative Sales"}
              </h3>
              <p
                className={`${metricValueClass(stats.negativeSales)} font-black mt-2 tabular-nums leading-tight whitespace-nowrap ${activeMetricFilter === "negativeSales" ? "text-white" : "text-rose-700"}`}
              >
                {formatNumber(stats.negativeSales)}
              </p>
              <div
                className={`mt-2 text-[11px] font-semibold ${activeMetricFilter === "negativeSales" ? "text-rose-200" : "text-rose-600"}`}
              >
                Click to filter categories
              </div>
            </div>

              </>
            )}

            {/* Zero Sales Card - dead stock: on the shelf, moving nothing.
                Inventory-derived, so it is not part of the sales view. */}
            {!isSales && (
            <div
              onClick={() => handleMetricCardClick("zeroSales")}
              className={`cursor-pointer backdrop-blur-3xl p-5 rounded-3xl border transition-all ${
                activeMetricFilter === "zeroSales"
                  ? "bg-violet-600 text-white shadow-lg ring-2 ring-violet-400"
                  : "bg-gradient-to-br from-violet-500/10 via-purple-500/5 to-white/40 border-violet-500/20 hover:border-violet-500/50"
              }`}
            >
              <h3
                className={`text-xs font-extrabold uppercase tracking-wider ${activeMetricFilter === "zeroSales" ? "text-violet-100" : "text-violet-700"}`}
              >
                Zero Sales
              </h3>
              <p
                className={`${metricValueClass(stats.zeroSales)} font-black mt-2 tabular-nums leading-tight whitespace-nowrap ${activeMetricFilter === "zeroSales" ? "text-white" : "text-violet-700"}`}
              >
                {formatNumber(stats.zeroSales)}
              </p>
              <div
                className={`mt-2 text-[11px] font-semibold ${activeMetricFilter === "zeroSales" ? "text-violet-200" : "text-violet-600"}`}
              >
                Click to filter categories
              </div>
            </div>
            )}

            {!isSales && (
              <>
            {/* Negative Stock Card */}
            <div
              onClick={() => handleMetricCardClick("negativeStock")}
              className={`cursor-pointer backdrop-blur-3xl p-5 rounded-3xl border transition-all ${
                activeMetricFilter === "negativeStock"
                  ? "bg-red-700 text-white shadow-lg ring-2 ring-red-400"
                  : "bg-gradient-to-br from-red-500/10 via-rose-500/5 to-white/40 border-red-500/20 hover:border-red-500/50"
              }`}
            >
              <h3
                className={`text-xs font-extrabold uppercase tracking-wider ${activeMetricFilter === "negativeStock" ? "text-red-100" : "text-red-700"}`}
              >
                Negative Stock
              </h3>
              <p
                className={`${metricValueClass(stats.negativeStock)} font-black mt-2 tabular-nums leading-tight whitespace-nowrap ${activeMetricFilter === "negativeStock" ? "text-white" : "text-red-700"}`}
              >
                {formatNumber(stats.negativeStock)}
              </p>
              <div
                className={`mt-2 text-[11px] font-semibold ${activeMetricFilter === "negativeStock" ? "text-red-200" : "text-red-600"}`}
              >
                Click to filter categories
              </div>
            </div>

            {/* Zero Stock Card */}
            <div
              onClick={() => handleMetricCardClick("zeroStock")}
              className={`cursor-pointer backdrop-blur-3xl p-5 rounded-3xl border transition-all ${
                activeMetricFilter === "zeroStock"
                  ? "bg-amber-600 text-white shadow-lg ring-2 ring-amber-400"
                  : "bg-gradient-to-br from-amber-500/10 via-yellow-500/5 to-white/40 border-amber-500/20 hover:border-amber-500/50"
              }`}
            >
              <h3
                className={`text-xs font-extrabold uppercase tracking-wider ${activeMetricFilter === "zeroStock" ? "text-amber-100" : "text-amber-700"}`}
              >
                Zero Stock
              </h3>
              <p
                className={`${metricValueClass(stats.zeroStock)} font-black mt-2 tabular-nums leading-tight whitespace-nowrap ${activeMetricFilter === "zeroStock" ? "text-white" : "text-amber-700"}`}
              >
                {formatNumber(stats.zeroStock)}
              </p>
              <div
                className={`mt-2 text-[11px] font-semibold ${activeMetricFilter === "zeroStock" ? "text-amber-200" : "text-amber-600"}`}
              >
                Click to filter categories
              </div>
            </div>
              </>
            )}
          </div>
        </div>

        {/* Categories Breakdown Section (First Level or Last Level Drill-down) */}
        <div className="mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
            <div className="flex items-center gap-3">
              {selectedCategory && (
                <button
                  type="button"
                  onClick={
                    productData
                      ? handleBackToSubCategories
                      : handleBackToFirstLevel
                  }
                  className="px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-200 hover:bg-slate-300 text-slate-700 transition flex items-center gap-1.5 shadow-sm"
                >
                  {productData
                    ? `← Back to ${selectedCategory}`
                    : "← Back to First Level"}
                </button>
              )}
              <h2 className="text-xl font-extrabold tracking-tight text-slate-900 drop-shadow-sm">
                {productData
                  ? productSearch
                    ? `Products matching "${productSearch}"${selectedCategory ? ` in ${selectedSubCategory || selectedCategory}` : ""}`
                    : `Products in "${selectedSubCategory || "—"}"`
                  : selectedCategory
                    ? `Last Level Categories for "${selectedCategory}"`
                    : "First Level Categories Breakdown"}
              </h2>
            </div>

            {/* Card name filter — only meaningful when cards are on screen */}
            <div
              className={`relative w-full sm:w-72 ${productData ? "hidden" : ""}`}
            >
              <span className="absolute inset-y-0 left-0 flex items-center pl-3.5 pointer-events-none text-slate-400">
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2.5"
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              </span>
              <input
                type="text"
                value={categorySearchQuery}
                onChange={(e) => setCategorySearchQuery(e.target.value)}
                placeholder="Filter by category..."
                className="w-full pl-10 pr-9 py-2.5 bg-white/70 backdrop-blur-xl border border-slate-200/80 rounded-2xl text-xs font-semibold text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all shadow-sm"
              />
              {categorySearchQuery && (
                <button
                  type="button"
                  onClick={() => setCategorySearchQuery("")}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600 text-xs font-bold"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {productData ? (
            <div className="bg-white/60 backdrop-blur-3xl rounded-3xl border border-white/60 shadow-[0_20px_50px_rgba(0,0,0,0.03)] overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-b border-slate-200/70">
                <p className="text-sm font-bold text-slate-700">
                  {productData.total.toLocaleString()} products
                  {!isSales && productData.stockDate && (
                    <span className="font-medium text-slate-500">
                      {" "}
                      · stock as at {productData.stockDate}
                    </span>
                  )}
                </p>
                {productData.total > productData.pageSize && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={productData.page <= 1}
                      onClick={() => setProductPage((p) => Math.max(1, p - 1))}
                      className="px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Previous
                    </button>
                    <span className="text-xs font-semibold text-slate-500 tabular-nums">
                      {productData.page} /{" "}
                      {Math.ceil(productData.total / productData.pageSize)}
                    </span>
                    <button
                      type="button"
                      disabled={
                        productData.page >=
                        Math.ceil(productData.total / productData.pageSize)
                      }
                      onClick={() => setProductPage((p) => p + 1)}
                      className="px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </div>
                )}
              </div>

              {productData.products.length === 0 ? (
                <div className="px-6 py-12 text-center text-slate-400 font-semibold">
                  No products match the selected filters.
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4 p-4">
                  {productData.products.map((p, i) => {
                    const rank =
                      (productData.page - 1) * productData.pageSize + i + 1;
                    return (
                      <div
                        key={p.barcode}
                        className="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-[0_6px_20px_rgba(0,0,0,0.04)] hover:shadow-[0_10px_28px_rgba(0,0,0,0.07)] transition"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <span className="px-2.5 py-1 rounded-full bg-blue-50 border border-blue-100 text-[11px] font-extrabold text-blue-700 font-mono">
                            SKU: {p.barcode}
                          </span>
                          <span className="text-[11px] font-bold text-slate-300">
                            #{rank}
                          </span>
                        </div>

                        <h3 className="mt-2.5 text-sm font-extrabold text-slate-900 leading-snug">
                          {p.articleName}
                        </h3>

                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          {p.type && (
                            <span className="px-3 py-1 rounded-full bg-white border border-slate-200 text-[10px] font-bold text-slate-600 uppercase tracking-wide">
                              {p.type}
                            </span>
                          )}
                          {p.sellingStatus && (
                            <span className="px-3 py-1 rounded-full bg-emerald-50 border border-emerald-100 text-[10px] font-bold text-emerald-700">
                              {p.sellingStatus}
                            </span>
                          )}
                          <span className="ml-auto text-xs font-extrabold text-slate-900 tabular-nums">
                            {isSales
                              ? formatAmount(p.amount)
                              : Math.round(p.sale).toLocaleString()}
                            <span className="text-[10px] font-bold text-slate-400">
                              {" "}
                              {isSales ? "amount" : "units sold"}
                            </span>
                            {!isSales && (
                              <>
                                <span className="text-slate-300"> · </span>
                                {Math.round(p.stock).toLocaleString()}
                                <span className="text-[10px] font-bold text-slate-400">
                                  {" "}
                                  stock
                                </span>
                              </>
                            )}
                          </span>
                        </div>

                        <div className="mt-3 pt-3 border-t border-slate-100">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400">
                              {isSales
                                ? "Amount by branch"
                                : (BRANCH_HEADING[activeMetricFilter] ?? "Branch Quantities")}
                            </span>
                            {/* Color-key legend so the two badges in each cell are self-explanatory
        without relying on the title="" tooltip. */}
                            {/* Legend */}
                            <span className="flex items-center gap-2.5 text-[10px] font-bold">
                              <span className="flex items-center gap-1">
                                <span className="w-2 h-2 rounded-full bg-indigo-500"></span>
                                <span className="text-indigo-600">
                                  {isSales ? "Amount" : "Sold"}
                                </span>
                              </span>
                              {!isSales && (
                                <span className="flex items-center gap-1">
                                  <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                                  <span className="text-emerald-600">Stock</span>
                                </span>
                              )}
                            </span>
                          </div>

                          {branchesForMetric(p).length === 0 && (
                            <p className="text-[11px] font-semibold text-slate-400 py-1">
                              No branch matches this filter for this product.
                            </p>
                          )}

                          <div className="grid grid-cols-3 sm:grid-cols-2 gap-2">
                            {branchesForMetric(p).map((b) => {
                              const qty = p.branchStock?.[b] ?? 0;
                              const sold = p.branchSales?.[b] ?? 0;
                              return (
                                <div
                                  key={b}
                                  className="flex flex-col gap-1 px-2.5 py-2 rounded-xl bg-slate-50 border border-slate-100"
                                >
                                  <span className="text-[10px] font-bold text-slate-500 truncate">
                                    {b}
                                  </span>
                                  <div className="flex items-center justify-between gap-1">
                                    <span
                                      className={`px-1.5 py-0.5 rounded-md text-[11px] font-extrabold tabular-nums ${
                                        sold
                                          ? "bg-indigo-50 text-indigo-700"
                                          : "bg-slate-100 text-slate-400"
                                      }`}
                                    >
                                      {isSales
                                        ? formatAmount(p.branchAmount?.[b] ?? 0)
                                        : Math.round(sold).toLocaleString()}
                                    </span>
                                    {!isSales && (
                                      <span
                                        className={`px-1.5 py-0.5 rounded-md text-[11px] font-extrabold tabular-nums ${
                                          qty < 0
                                            ? "bg-rose-100 text-rose-700"
                                            : qty === 0
                                              ? "bg-slate-200 text-slate-500"
                                              : "bg-emerald-50 text-emerald-700"
                                        }`}
                                      >
                                        {Math.round(qty).toLocaleString()}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : loading && !hasLoadedOnce ? (
            <div className="bg-white/40 backdrop-blur-3xl p-10 rounded-3xl border border-white/60 text-center text-slate-400 font-semibold shadow-[0_20px_50px_rgba(0,0,0,0.03)]">
              Loading category analytics cards...
            </div>
          ) : filteredCategories.length === 0 ? (
            <div className="bg-white/40 backdrop-blur-3xl p-10 rounded-3xl border border-white/60 text-center text-slate-400 font-semibold shadow-[0_20px_50px_rgba(0,0,0,0.03)]">
              {categorySearchQuery
                ? `No categories found matching "${categorySearchQuery}".`
                : "No categories found for the selected filters."}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {filteredCategories.map((cat, idx) => (
                <div
                  key={idx}
                  onClick={() => {
                    if (!selectedCategory)
                      handleCategoryClick(cat.categoryName);
                    else handleSubCategoryClick(cat.categoryName);
                  }}
                  className={`bg-white/40 backdrop-blur-3xl p-6 rounded-3xl border border-white/60 shadow-[0_20px_50px_rgba(0,0,0,0.03)] hover:shadow-[0_20px_50px_rgba(0,0,0,0.06)] hover:border-white/80 transition-all flex flex-col justify-between ${"cursor-pointer group hover:bg-white/60"}`}
                >
                  <div>
                    {/* Category Title & Product Count Badge */}
                    <div className="flex items-start justify-between gap-2 mb-4">
                      <div>
                        <h3 className="text-base font-extrabold text-slate-900 tracking-tight group-hover:text-blue-600 transition-colors">
                          {cat.categoryName}
                        </h3>
                        {/* Both levels are drillable, so both say so. */}
                        <span className="text-[10px] font-bold text-blue-500 uppercase tracking-wider">
                          {selectedCategory
                            ? "Click to view products →"
                            : "Click to view sub-categories →"}
                        </span>
                      </div>
                      <span className="px-3 py-1 rounded-full text-xs font-bold bg-white/70 text-slate-600 border border-white/90 shadow-sm shrink-0 backdrop-blur-md">
                        {cat.productCount.toLocaleString()} items
                      </span>
                    </div>

                    {/* Beautified Pill Metric Container matching Summary Card themes */}
                    <div className="space-y-2.5 bg-white/50 backdrop-blur-md p-4 rounded-2xl border border-white/80 shadow-[0_4px_15px_rgba(0,0,0,0.02)]">
                      {isSales && cat.amount !== undefined && (
                        <div className="flex items-center justify-between px-3.5 py-2.5 bg-gradient-to-r from-emerald-500/15 via-teal-500/10 to-emerald-500/5 border border-emerald-500/30 rounded-2xl transition-all shadow-[0_2px_8px_rgba(16,185,129,0.04)]">
                          <span className="flex items-center gap-2 text-xs font-extrabold text-emerald-900 uppercase tracking-wide">
                            <span className="w-2.5 h-2.5 rounded-full bg-emerald-600 shadow-[0_0_8px_rgba(16,185,129,0.7)]"></span>
                            Amount
                          </span>
                          <span
                            title={exactAmount(cat.amount)}
                            className="font-black text-emerald-950 text-sm tabular-nums"
                          >
                            {formatAmount(cat.amount)}
                          </span>
                        </div>
                      )}

                      {!isSales && (
                        <>
                      {(!activeMetricFilter ||
                        activeMetricFilter === "totalSales") && (
                        <div className="flex items-center justify-between px-3.5 py-2.5 bg-gradient-to-r from-indigo-500/15 via-blue-500/10 to-indigo-500/5 border border-indigo-500/30 rounded-2xl transition-all shadow-[0_2px_8px_rgba(79,70,229,0.04)]">
                          <span className="flex items-center gap-2 text-xs font-extrabold text-indigo-900 uppercase tracking-wide">
                            <span className="w-2.5 h-2.5 rounded-full bg-indigo-600 shadow-[0_0_8px_rgba(79,70,229,0.7)]"></span>
                            {isSales ? "Units (Net)" : "Net Sales"}
                          </span>
                          <span className="font-black text-indigo-950 text-sm">
                            {cat.totalSales.toLocaleString()}
                          </span>
                        </div>
                      )}

                      {(!activeMetricFilter ||
                        activeMetricFilter === "positiveSales") && (
                        <div className="flex items-center justify-between px-3.5 py-2.5 bg-gradient-to-r from-teal-500/15 via-emerald-500/10 to-teal-500/5 border border-teal-500/30 rounded-2xl transition-all shadow-[0_2px_8px_rgba(13,148,136,0.04)]">
                          <span className="flex items-center gap-2 text-xs font-extrabold text-teal-900 uppercase tracking-wide">
                            <span className="w-2.5 h-2.5 rounded-full bg-teal-600 shadow-[0_0_8px_rgba(13,148,136,0.7)]"></span>
                            Positive Sales
                          </span>
                          <span className="font-black text-teal-950 text-sm">
                            {cat.positiveSales.toLocaleString()}
                          </span>
                        </div>
                      )}

                      {(!activeMetricFilter ||
                        activeMetricFilter === "negativeSales") && (
                        <div className="flex items-center justify-between px-3.5 py-2.5 bg-gradient-to-r from-rose-500/15 via-orange-500/10 to-rose-500/5 border border-rose-500/30 rounded-2xl transition-all shadow-[0_2px_8px_rgba(225,29,72,0.04)]">
                          <span className="flex items-center gap-2 text-xs font-extrabold text-rose-900 uppercase tracking-wide">
                            <span className="w-2.5 h-2.5 rounded-full bg-rose-600 shadow-[0_0_8px_rgba(225,29,72,0.7)]"></span>
                            Negative Sales
                          </span>
                          <span className="font-black text-rose-950 text-sm">
                            {cat.negativeSales.toLocaleString()}
                          </span>
                        </div>
                      )}

                        </>
                      )}

                      {!isSales && (
                        <>
                      {(!activeMetricFilter ||
                        activeMetricFilter === "zeroSales") && (
                        <div className="flex items-center justify-between px-3.5 py-2.5 bg-gradient-to-r from-violet-500/15 via-purple-500/10 to-violet-500/5 border border-violet-500/30 rounded-2xl transition-all shadow-[0_2px_8px_rgba(124,58,237,0.04)]">
                          <span className="flex items-center gap-2 text-xs font-extrabold text-violet-900 uppercase tracking-wide">
                            <span className="w-2.5 h-2.5 rounded-full bg-violet-600 shadow-[0_0_8px_rgba(124,58,237,0.7)]"></span>
                            Zero Sales
                          </span>
                          <span className="font-black text-violet-950 text-sm">
                            {formatNumber(cat.zeroSalesCount)}
                          </span>
                        </div>
                      )}

                      {(!activeMetricFilter ||
                        activeMetricFilter === "negativeStock") && (
                        <div className="flex items-center justify-between px-3.5 py-2.5 bg-gradient-to-r from-red-500/15 via-rose-500/10 to-red-500/5 border border-red-500/30 rounded-2xl transition-all shadow-[0_2px_8px_rgba(220,38,38,0.04)]">
                          <span className="flex items-center gap-2 text-xs font-extrabold text-red-900 uppercase tracking-wide">
                            <span className="w-2.5 h-2.5 rounded-full bg-red-600 shadow-[0_0_8px_rgba(220,38,38,0.7)]"></span>
                            Negative Stock
                          </span>
                          <span className="font-black text-red-950 text-sm">
                            {formatNumber(cat.negativeStockCount)}
                          </span>
                        </div>
                      )}

                      {(!activeMetricFilter ||
                        activeMetricFilter === "zeroStock") && (
                        <div className="flex items-center justify-between px-3.5 py-2.5 bg-gradient-to-r from-amber-500/15 via-yellow-500/10 to-amber-500/5 border border-amber-500/30 rounded-2xl transition-all shadow-[0_2px_8px_rgba(217,119,6,0.04)]">
                          <span className="flex items-center gap-2 text-xs font-extrabold text-amber-900 uppercase tracking-wide">
                            <span className="w-2.5 h-2.5 rounded-full bg-amber-600 shadow-[0_0_8px_rgba(217,119,6,0.7)]"></span>
                            Zero Stock
                          </span>
                          <span className="font-black text-amber-950 text-sm">
                            {formatNumber(cat.zeroStockCount)}
                          </span>
                        </div>
                      )}

                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
