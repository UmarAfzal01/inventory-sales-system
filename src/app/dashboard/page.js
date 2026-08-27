"use client";
import { useState, useEffect, useRef } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";

export default function DashboardPage() {
  const router = useRouter();
  const pathname = usePathname();
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
  const [filters, setFilters] = useState({ branches: [], types: [], statuses: [] });
  
  // Initialize states from URL query params
  const [selectedBranch, setSelectedBranch] = useState(urlBranch || "ALL");
  const [selectedType, setSelectedType] = useState(urlType || "ALL");
  const [selectedStatus, setSelectedStatus] = useState(urlStatus || "ALL");
  const [activeMetricFilter, setActiveMetricFilter] = useState(urlMetric || null);
  const [fromDate, setFromDate] = useState(urlFrom || "");
  const [toDate, setToDate] = useState(urlTo || "");
  const [selectedCategory, setSelectedCategory] = useState(urlCategory || null);

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
  }, [urlBranch, urlType, urlStatus, urlMetric, urlFrom, urlTo, urlCategory]);

  // Update URL parameters helper including category drill-down
  const updateUrlParams = (newBranch, newType, newStatus, newMetric, newFrom, newTo, newCategory) => {
    const params = new URLSearchParams(searchParams.toString());
    
    if (newBranch && newBranch !== "ALL") params.set("branch", newBranch);
    else params.delete("branch");

    if (newType && newType !== "ALL") params.set("type", newType);
    else params.delete("type");

    if (newStatus && newStatus !== "ALL") params.set("sellingStatus", newStatus);
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
  const [dateBounds, setDateBounds] = useState({ minDate: null, maxDate: null });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const onDataUpdated = () => setReloadKey((k) => k + 1);
    window.addEventListener("inventory:data-updated", onDataUpdated);
    return () => window.removeEventListener("inventory:data-updated", onDataUpdated);
  }, []);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (branchRef.current && !branchRef.current.contains(e.target)) setBranchOpen(false);
      if (typeRef.current && !typeRef.current.contains(e.target)) setTypeOpen(false);
      if (statusRef.current && !statusRef.current.contains(e.target)) setStatusOpen(false);
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
        if (selectedCategory) qp.set("category", selectedCategory); // Pass category parameter to API if drilled down

        const res = await fetch(`/api/dashboard?${qp.toString()}`, {
          signal: controller.signal,
        }).then((r) => r.json());

        if (res.needsUpload) {
          setSetupNeeded(true);
          return;
        }
        if (!res.success) throw new Error(res.error || "Dashboard request failed");

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
  }, [selectedBranch, selectedType, selectedStatus, fromDate, toDate, selectedCategory, reloadKey]);

  const formatNumber = (val) => {
    if (loading && !hasLoadedOnce) return "—";
    return val !== undefined && val !== null ? val.toLocaleString() : "0";
  };

  const handleMetricCardClick = (metricKey) => {
    const newMetric = activeMetricFilter === metricKey ? null : metricKey;
    setActiveMetricFilter(newMetric);
    updateUrlParams(selectedBranch, selectedType, selectedStatus, newMetric, fromDate, toDate, selectedCategory);
  };

  // Handle clicking a first level category card to drill down
  const handleCategoryClick = (categoryName) => {
    setSelectedCategory(categoryName);
    setCategorySearchQuery(""); // reset search on category change
    updateUrlParams(selectedBranch, selectedType, selectedStatus, activeMetricFilter, fromDate, toDate, categoryName);
  };

  // Handle going back from last level categories to first level view
  const handleBackToFirstLevel = () => {
    setSelectedCategory(null);
    setCategorySearchQuery("");
    updateUrlParams(selectedBranch, selectedType, selectedStatus, activeMetricFilter, fromDate, toDate, null);
  };

  // Filter categories based on the search query input
  const filteredCategories = categoriesData.filter((cat) =>
    cat.categoryName.toLowerCase().includes(categorySearchQuery.toLowerCase())
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
              Enterprise Analytics {selectedBranch !== "ALL" && <span className="text-blue-600">— {selectedBranch}</span>}
            </h1>
            <p className="text-sm text-slate-500 font-medium mt-1">
              Real-time multi-branch inventory tracking, sales performance, and catalog overview.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold bg-emerald-500/10 text-emerald-700 border border-emerald-500/20 shadow-sm backdrop-blur-md">
              <span className={`w-2 h-2 rounded-full ${loading ? "bg-amber-500" : "bg-emerald-500 animate-ping shadow-[0_0_8px_rgba(16,185,129,0.8)]"}`}></span>
              {loading ? "Updating Metrics..." : "Live Sync Active"}
            </span>
            {setupNeeded && (
              <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold bg-amber-500/10 text-amber-800 border border-amber-500/20 shadow-sm backdrop-blur-md">
                <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                Summary data not built yet
              </span>
            )}
          </div>
        </div>

        {/* Filters Bar */}
        <div className="relative z-30 grid grid-cols-1 md:grid-cols-3 gap-5 bg-white/70 backdrop-blur-3xl p-6 rounded-3xl border border-white/80 shadow-[0_20px_50px_rgba(0,0,0,0.05)] mb-8">
          <div className="absolute -top-10 -right-10 w-32 h-32 bg-blue-400/10 rounded-full blur-2xl pointer-events-none"></div>

          {/* Branch Location Dropdown */}
          <div className="relative" ref={branchRef}>
            <label className="block text-xs font-extrabold text-slate-400 uppercase tracking-wider mb-2">
              Branch Location
            </label>
            <button
              type="button"
              onClick={() => { setBranchOpen(!branchOpen); setTypeOpen(false); setStatusOpen(false); }}
              className="w-full px-4 py-3 bg-white/80 hover:bg-white border border-slate-200/80 rounded-2xl text-sm text-slate-800 font-semibold flex items-center justify-between transition-all shadow-sm backdrop-blur-md"
            >
              <span className="truncate">{selectedBranch === "ALL" ? "All Branches" : selectedBranch}</span>
              <svg className={`w-4 h-4 text-slate-400 transition-transform duration-200 shrink-0 ${branchOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {branchOpen && (
              <div className="absolute top-full left-0 right-0 mt-2 bg-white/95 backdrop-blur-3xl border border-slate-200/80 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.15)] z-50 overflow-hidden p-1.5 space-y-1 max-h-60 overflow-y-auto">
                <button
                  type="button"
                  onClick={() => { 
                    setSelectedBranch("ALL"); 
                    setBranchOpen(false);
                    updateUrlParams("ALL", selectedType, selectedStatus, activeMetricFilter, fromDate, toDate, selectedCategory);
                  }}
                  className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                    selectedBranch === "ALL" ? "bg-blue-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
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
                      updateUrlParams(b, selectedType, selectedStatus, activeMetricFilter, fromDate, toDate, selectedCategory);
                    }}
                    className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all truncate ${
                      selectedBranch === b ? "bg-blue-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
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
              onClick={() => { setTypeOpen(!typeOpen); setBranchOpen(false); setStatusOpen(false); }}
              className="w-full px-4 py-3 bg-white/80 hover:bg-white border border-slate-200/80 rounded-2xl text-sm text-slate-800 font-semibold flex items-center justify-between transition-all shadow-sm backdrop-blur-md"
            >
              <span className="truncate">{selectedType === "ALL" ? "All Types" : selectedType}</span>
              <svg className={`w-4 h-4 text-slate-400 transition-transform duration-200 shrink-0 ${typeOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {typeOpen && (
              <div className="absolute top-full left-0 right-0 mt-2 bg-white/95 backdrop-blur-3xl border border-slate-200/80 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.15)] z-50 overflow-hidden p-1.5 space-y-1 max-h-60 overflow-y-auto">
                <button
                  type="button"
                  onClick={() => { 
                    setSelectedType("ALL"); 
                    setTypeOpen(false);
                    updateUrlParams(selectedBranch, "ALL", selectedStatus, activeMetricFilter, fromDate, toDate, selectedCategory);
                  }}
                  className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                    selectedType === "ALL" ? "bg-blue-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
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
                      updateUrlParams(selectedBranch, t, selectedStatus, activeMetricFilter, fromDate, toDate, selectedCategory);
                    }}
                    className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all truncate ${
                      selectedType === t ? "bg-blue-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
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
              onClick={() => { setStatusOpen(!statusOpen); setBranchOpen(false); setTypeOpen(false); }}
              className="w-full px-4 py-3 bg-white/80 hover:bg-white border border-slate-200/80 rounded-2xl text-sm text-slate-800 font-semibold flex items-center justify-between transition-all shadow-sm backdrop-blur-md"
            >
              <span className="truncate">{selectedStatus === "ALL" ? "All Statuses" : selectedStatus}</span>
              <svg className={`w-4 h-4 text-slate-400 transition-transform duration-200 shrink-0 ${statusOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {statusOpen && (
              <div className="absolute top-full left-0 right-0 mt-2 bg-white/95 backdrop-blur-3xl border border-slate-200/80 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.15)] z-50 overflow-hidden p-1.5 space-y-1 max-h-60 overflow-y-auto">
                <button
                  type="button"
                  onClick={() => { 
                    setSelectedStatus("ALL"); 
                    setStatusOpen(false);
                    updateUrlParams(selectedBranch, selectedType, "ALL", activeMetricFilter, fromDate, toDate, selectedCategory);
                  }}
                  className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                    selectedStatus === "ALL" ? "bg-blue-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
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
                      updateUrlParams(selectedBranch, selectedType, s, activeMetricFilter, fromDate, toDate, selectedCategory);
                    }}
                    className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all truncate ${
                      selectedStatus === s ? "bg-blue-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
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
                  updateUrlParams(selectedBranch, selectedType, selectedStatus, activeMetricFilter, val, toDate, selectedCategory);
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
                  updateUrlParams(selectedBranch, selectedType, selectedStatus, activeMetricFilter, fromDate, val, selectedCategory);
                }}
                className="bg-white border border-slate-300 text-slate-800 text-sm rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              {[
                { label: "Last 7 days", days: 7 },
                { label: "Last 30 days", days: 30 },
              ].map((p) => (
                <button
                  key={p.days}
                  type="button"
                  onClick={() => {
                    const end = dateBounds.maxDate ? new Date(dateBounds.maxDate) : new Date();
                    const start = new Date(end);
                    start.setUTCDate(start.getUTCDate() - (p.days - 1));
                    const startStr = start.toISOString().slice(0, 10);
                    const endStr = end.toISOString().slice(0, 10);

                    setFromDate(startStr);
                    setToDate(endStr);
                    updateUrlParams(selectedBranch, selectedType, selectedStatus, activeMetricFilter, startStr, endStr, selectedCategory);
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
                    updateUrlParams(selectedBranch, selectedType, selectedStatus, activeMetricFilter, "", "", selectedCategory);
                  }}
                  className="px-3 py-2 rounded-xl text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 transition"
                >
                  Clear dates ✕
                </button>
              )}
            </div>

          </div>

          {dateFiltered && (
            stockAvailable ? (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mt-3">
                Sales reflect the selected dates. Stock as at {stockDate}.
              </p>
            ) : (
              <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2 mt-3">
                Sales reflect the selected dates. No stock count exists on or before{" "}
                {toDate || "this date"}, so stock figures are not shown.
              </p>
            )
          )}
        </div>

        {/* Sales & Stock Performance Section */}
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
          
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {/* Net Sales Card */}
            <div 
              onClick={() => handleMetricCardClick('totalSales')}
              className={`cursor-pointer backdrop-blur-3xl p-5 rounded-3xl border transition-all ${
                activeMetricFilter === 'totalSales' 
                  ? 'bg-indigo-600 text-white shadow-lg ring-2 ring-indigo-400' 
                  : 'bg-gradient-to-br from-indigo-500/10 via-blue-500/5 to-white/40 border-indigo-500/20 hover:border-indigo-500/50'
              }`}
            >
              <h3 className={`text-xs font-extrabold uppercase tracking-wider ${activeMetricFilter === 'totalSales' ? 'text-indigo-100' : 'text-indigo-700'}`}>Total Sales (Net)</h3>
              <p className={`text-2xl font-black mt-2 ${activeMetricFilter === 'totalSales' ? 'text-white' : 'text-slate-900'}`}>
                {formatNumber(stats.totalSales)}
              </p>
              <div className={`mt-2 text-[11px] font-semibold ${activeMetricFilter === 'totalSales' ? 'text-indigo-200' : 'text-indigo-600'}`}>Click to filter categories</div>
            </div>

            {/* Positive Sales Card */}
            <div 
              onClick={() => handleMetricCardClick('positiveSales')}
              className={`cursor-pointer backdrop-blur-3xl p-5 rounded-3xl border transition-all ${
                activeMetricFilter === 'positiveSales' 
                  ? 'bg-teal-600 text-white shadow-lg ring-2 ring-teal-400' 
                  : 'bg-gradient-to-br from-teal-500/10 via-emerald-500/5 to-white/40 border-teal-500/20 hover:border-teal-500/50'
              }`}
            >
              <h3 className={`text-xs font-extrabold uppercase tracking-wider ${activeMetricFilter === 'positiveSales' ? 'text-teal-100' : 'text-teal-700'}`}>Positive Sales</h3>
              <p className={`text-2xl font-black mt-2 ${activeMetricFilter === 'positiveSales' ? 'text-white' : 'text-teal-700'}`}>
                {formatNumber(stats.positiveSales)}
              </p>
              <div className={`mt-2 text-[11px] font-semibold ${activeMetricFilter === 'positiveSales' ? 'text-teal-200' : 'text-teal-600'}`}>Click to filter categories</div>
            </div>

            {/* Negative Sales Card */}
            <div 
              onClick={() => handleMetricCardClick('negativeSales')}
              className={`cursor-pointer backdrop-blur-3xl p-5 rounded-3xl border transition-all ${
                activeMetricFilter === 'negativeSales' 
                  ? 'bg-rose-600 text-white shadow-lg ring-2 ring-rose-400' 
                  : 'bg-gradient-to-br from-rose-500/10 via-orange-500/5 to-white/40 border-rose-500/20 hover:border-rose-500/50'
              }`}
            >
              <h3 className={`text-xs font-extrabold uppercase tracking-wider ${activeMetricFilter === 'negativeSales' ? 'text-rose-100' : 'text-rose-700'}`}>Negative Sales</h3>
              <p className={`text-2xl font-black mt-2 ${activeMetricFilter === 'negativeSales' ? 'text-white' : 'text-rose-700'}`}>
                {formatNumber(stats.negativeSales)}
              </p>
              <div className={`mt-2 text-[11px] font-semibold ${activeMetricFilter === 'negativeSales' ? 'text-rose-200' : 'text-rose-600'}`}>Click to filter categories</div>
            </div>

            {/* Negative Stock Card */}
            <div 
              onClick={() => handleMetricCardClick('negativeStock')}
              className={`cursor-pointer backdrop-blur-3xl p-5 rounded-3xl border transition-all ${
                activeMetricFilter === 'negativeStock' 
                  ? 'bg-red-700 text-white shadow-lg ring-2 ring-red-400' 
                  : 'bg-gradient-to-br from-red-500/10 via-rose-500/5 to-white/40 border-red-500/20 hover:border-red-500/50'
              }`}
            >
              <h3 className={`text-xs font-extrabold uppercase tracking-wider ${activeMetricFilter === 'negativeStock' ? 'text-red-100' : 'text-red-700'}`}>Negative Stock</h3>
              <p className={`text-2xl font-black mt-2 ${activeMetricFilter === 'negativeStock' ? 'text-white' : 'text-red-700'}`}>
                {formatNumber(stats.negativeStock)}
              </p>
              <div className={`mt-2 text-[11px] font-semibold ${activeMetricFilter === 'negativeStock' ? 'text-red-200' : 'text-red-600'}`}>Click to filter categories</div>
            </div>

            {/* Zero Stock Card */}
            <div 
              onClick={() => handleMetricCardClick('zeroStock')}
              className={`cursor-pointer backdrop-blur-3xl p-5 rounded-3xl border transition-all ${
                activeMetricFilter === 'zeroStock' 
                  ? 'bg-amber-600 text-white shadow-lg ring-2 ring-amber-400' 
                  : 'bg-gradient-to-br from-amber-500/10 via-yellow-500/5 to-white/40 border-amber-500/20 hover:border-amber-500/50'
              }`}
            >
              <h3 className={`text-xs font-extrabold uppercase tracking-wider ${activeMetricFilter === 'zeroStock' ? 'text-amber-100' : 'text-amber-700'}`}>Zero Stock</h3>
              <p className={`text-2xl font-black mt-2 ${activeMetricFilter === 'zeroStock' ? 'text-white' : 'text-amber-700'}`}>
                {formatNumber(stats.zeroStock)}
              </p>
              <div className={`mt-2 text-[11px] font-semibold ${activeMetricFilter === 'zeroStock' ? 'text-amber-200' : 'text-amber-600'}`}>Click to filter categories</div>
            </div>
          </div>
        </div>

        {/* Categories Breakdown Section (First Level or Last Level Drill-down) */}
        <div className="mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
            <div className="flex items-center gap-3">
              {selectedCategory && (
                <button
                  type="button"
                  onClick={handleBackToFirstLevel}
                  className="px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-200 hover:bg-slate-300 text-slate-700 transition flex items-center gap-1.5 shadow-sm"
                >
                  ← Back to First Level
                </button>
              )}
              <h2 className="text-xl font-extrabold tracking-tight text-slate-900 drop-shadow-sm">
                {selectedCategory ? `Last Level Categories for "${selectedCategory}"` : "First Level Categories Breakdown"}
              </h2>
            </div>

            {/* Category Search Input Bar */}
            <div className="relative w-full sm:w-72">
              <span className="absolute inset-y-0 left-0 flex items-center pl-3.5 pointer-events-none text-slate-400">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </span>
              <input
                type="text"
                value={categorySearchQuery}
                onChange={(e) => setCategorySearchQuery(e.target.value)}
                placeholder="Search category name..."
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
          
          {loading && !hasLoadedOnce ? (
            <div className="bg-white/40 backdrop-blur-3xl p-10 rounded-3xl border border-white/60 text-center text-slate-400 font-semibold shadow-[0_20px_50px_rgba(0,0,0,0.03)]">
              Loading category analytics cards...
            </div>
          ) : filteredCategories.length === 0 ? (
            <div className="bg-white/40 backdrop-blur-3xl p-10 rounded-3xl border border-white/60 text-center text-slate-400 font-semibold shadow-[0_20px_50px_rgba(0,0,0,0.03)]">
              {categorySearchQuery ? `No categories found matching "${categorySearchQuery}".` : "No categories found for the selected filters."}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {filteredCategories.map((cat, idx) => (
                <div 
                  key={idx} 
                  onClick={() => {
                    // Only drill down if we are currently looking at first-level categories
                    if (!selectedCategory) {
                      handleCategoryClick(cat.categoryName);
                    }
                  }}
                  className={`bg-white/40 backdrop-blur-3xl p-6 rounded-3xl border border-white/60 shadow-[0_20px_50px_rgba(0,0,0,0.03)] hover:shadow-[0_20px_50px_rgba(0,0,0,0.06)] hover:border-white/80 transition-all flex flex-col justify-between ${
                    !selectedCategory ? "cursor-pointer group hover:bg-white/60" : ""
                  }`}
                >
                  <div>
                    {/* Category Title & Product Count Badge */}
                    <div className="flex items-start justify-between gap-2 mb-4">
                      <div>
                        <h3 className={`text-base font-extrabold text-slate-900 tracking-tight ${!selectedCategory ? "group-hover:text-blue-600 transition-colors" : ""}`}>
                          {cat.categoryName}
                        </h3>
                        {!selectedCategory && (
                          <span className="text-[10px] font-bold text-blue-500 uppercase tracking-wider">Click to view sub-categories →</span>
                        )}
                      </div>
                      <span className="px-3 py-1 rounded-full text-xs font-bold bg-white/70 text-slate-600 border border-white/90 shadow-sm shrink-0 backdrop-blur-md">
                        {cat.productCount.toLocaleString()} items
                      </span>
                    </div>

                    {/* Beautified Pill Metric Container matching Summary Card themes */}
                    <div className="space-y-2.5 bg-white/50 backdrop-blur-md p-4 rounded-2xl border border-white/80 shadow-[0_4px_15px_rgba(0,0,0,0.02)]">
                      
                      {(!activeMetricFilter || activeMetricFilter === 'totalSales') && (
                        <div className="flex items-center justify-between px-3.5 py-2.5 bg-gradient-to-r from-indigo-500/15 via-blue-500/10 to-indigo-500/5 border border-indigo-500/30 rounded-2xl transition-all shadow-[0_2px_8px_rgba(79,70,229,0.04)]">
                          <span className="flex items-center gap-2 text-xs font-extrabold text-indigo-900 uppercase tracking-wide">
                            <span className="w-2.5 h-2.5 rounded-full bg-indigo-600 shadow-[0_0_8px_rgba(79,70,229,0.7)]"></span>
                            Net Sales
                          </span>
                          <span className="font-black text-indigo-950 text-sm">{cat.totalSales.toLocaleString()}</span>
                        </div>
                      )}

                      {(!activeMetricFilter || activeMetricFilter === 'positiveSales') && (
                        <div className="flex items-center justify-between px-3.5 py-2.5 bg-gradient-to-r from-teal-500/15 via-emerald-500/10 to-teal-500/5 border border-teal-500/30 rounded-2xl transition-all shadow-[0_2px_8px_rgba(13,148,136,0.04)]">
                          <span className="flex items-center gap-2 text-xs font-extrabold text-teal-900 uppercase tracking-wide">
                            <span className="w-2.5 h-2.5 rounded-full bg-teal-600 shadow-[0_0_8px_rgba(13,148,136,0.7)]"></span>
                            Positive Sales
                          </span>
                          <span className="font-black text-teal-950 text-sm">{cat.positiveSales.toLocaleString()}</span>
                        </div>
                      )}

                      {(!activeMetricFilter || activeMetricFilter === 'negativeSales') && (
                        <div className="flex items-center justify-between px-3.5 py-2.5 bg-gradient-to-r from-rose-500/15 via-orange-500/10 to-rose-500/5 border border-rose-500/30 rounded-2xl transition-all shadow-[0_2px_8px_rgba(225,29,72,0.04)]">
                          <span className="flex items-center gap-2 text-xs font-extrabold text-rose-900 uppercase tracking-wide">
                            <span className="w-2.5 h-2.5 rounded-full bg-rose-600 shadow-[0_0_8px_rgba(225,29,72,0.7)]"></span>
                            Negative Sales
                          </span>
                          <span className="font-black text-rose-950 text-sm">{cat.negativeSales.toLocaleString()}</span>
                        </div>
                      )}

                      {(!activeMetricFilter || activeMetricFilter === 'negativeStock') && (
                        <div className="flex items-center justify-between px-3.5 py-2.5 bg-gradient-to-r from-red-500/15 via-rose-500/10 to-red-500/5 border border-red-500/30 rounded-2xl transition-all shadow-[0_2px_8px_rgba(220,38,38,0.04)]">
                          <span className="flex items-center gap-2 text-xs font-extrabold text-red-900 uppercase tracking-wide">
                            <span className="w-2.5 h-2.5 rounded-full bg-red-600 shadow-[0_0_8px_rgba(220,38,38,0.7)]"></span>
                            Negative Stock
                          </span>
                          <span className="font-black text-red-950 text-sm">{cat.negativeStockCount.toLocaleString()}</span>
                        </div>
                      )}

                      {(!activeMetricFilter || activeMetricFilter === 'zeroStock') && (
                        <div className="flex items-center justify-between px-3.5 py-2.5 bg-gradient-to-r from-amber-500/15 via-yellow-500/10 to-amber-500/5 border border-amber-500/30 rounded-2xl transition-all shadow-[0_2px_8px_rgba(217,119,6,0.04)]">
                          <span className="flex items-center gap-2 text-xs font-extrabold text-amber-900 uppercase tracking-wide">
                            <span className="w-2.5 h-2.5 rounded-full bg-amber-600 shadow-[0_0_8px_rgba(217,119,6,0.7)]"></span>
                            Zero Stock
                          </span>
                          <span className="font-black text-amber-950 text-sm">{cat.zeroStockCount.toLocaleString()}</span>
                        </div>
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