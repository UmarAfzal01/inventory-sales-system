"use client";
import { useState, useEffect } from "react";

export default function DashboardPage() {
  const [loading, setLoading] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [stats, setStats] = useState({
    totalProducts: 0,
    totalInventory: 0,
    totalSales: 0,
    positiveSales: 0,
    negativeSales: 0,
    negativeStock: 0,
    zeroStock: 0,
  });
  const [categoriesData, setCategoriesData] = useState([]);
  const [filters, setFilters] = useState({ branches: [], types: [], statuses: [] });
  const [selectedBranch, setSelectedBranch] = useState("ALL");
  const [selectedType, setSelectedType] = useState("ALL");
  const [selectedStatus, setSelectedStatus] = useState("ALL");
  // "rollup" = served from the pre-aggregated cache. "live-scan" = the cache is
  // Set when the rollups have never been built, so the dashboard can say what
  // to do instead of silently showing zeros.
  const [setupNeeded, setSetupNeeded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      setLoading(true);
      try {
        const queryParams = new URLSearchParams({
          branch: selectedBranch,
          type: selectedType,
          sellingStatus: selectedStatus,
        }).toString();

        // One request. This used to fan out to four endpoints, three of which
        // each streamed the entire products collection into the server to sum
        // it there.
        const res = await fetch(`/api/dashboard?${queryParams}`, {
          signal: controller.signal,
        }).then((r) => r.json());
        if (res.needsBackfill) {
          setSetupNeeded(true);
          return;
        }
        if (!res.success) throw new Error(res.error || "Dashboard request failed");

        setSetupNeeded(false);
        setStats(res.stats);
        setFilters(res.filtersList);
        setCategoriesData(res.categories);
      } catch (err) {
        // A superseded request is not an error worth surfacing.
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
    // Cancel in-flight work when filters change again, so a slow earlier
    // response cannot overwrite a newer one.
    return () => controller.abort();
  }, [selectedBranch, selectedType, selectedStatus]);

  const formatNumber = (val) => {
    if (loading && !hasLoadedOnce) return "—";
    return val !== undefined && val !== null ? val.toLocaleString() : "0";
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950 relative pb-16 selection:bg-blue-600 selection:text-white">
      {/* Top Animated Loading Bar */}
      {loading && (
        <div className="fixed top-0 left-0 right-0 z-50 h-1.5 bg-slate-200 overflow-hidden">
          <div className="w-full h-full bg-gradient-to-r from-blue-600 via-indigo-600 to-teal-500 animate-pulse transition-all duration-300"></div>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-10">
        {/* Header Section */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-slate-900">
              Enterprise Analytics
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Real-time multi-branch inventory tracking, sales performance, and catalog overview.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 shadow-sm">
              <span className={`w-2 h-2 rounded-full ${loading ? "bg-amber-500" : "bg-emerald-500 animate-ping"}`}></span>
              {loading ? "Updating Metrics..." : "Live Sync Active"}
            </span>
            {setupNeeded && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200 shadow-sm">
                <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                Summary data not built yet
              </span>
            )}
          </div>
        </div>

        {/* Filters Bar */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm mb-8">
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
              Branch Location
            </label>
            <select
              value={selectedBranch}
              onChange={(e) => setSelectedBranch(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-sm text-slate-800 font-medium focus:outline-none focus:ring-2 focus:ring-blue-600 focus:bg-white transition-all"
            >
              <option value="ALL">All Branches</option>
              {filters.branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
              Product Type
            </label>
            <select
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-sm text-slate-800 font-medium focus:outline-none focus:ring-2 focus:ring-blue-600 focus:bg-white transition-all"
            >
              <option value="ALL">All Types</option>
              {filters.types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
              Selling Status
            </label>
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-sm text-slate-800 font-medium focus:outline-none focus:ring-2 focus:ring-blue-600 focus:bg-white transition-all"
            >
              <option value="ALL">All Statuses</option>
              {filters.statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Main Metric Cards Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md hover:border-blue-400 transition-all group">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Total Unique Products</h3>
            <p className="text-3xl font-extrabold text-slate-900 mt-2 group-hover:scale-[1.02] transition-transform origin-left">
              {formatNumber(stats.totalProducts)}
            </p>
            <div className="mt-2 text-xs text-blue-600 font-semibold">Master database records</div>
          </div>

          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md hover:border-emerald-400 transition-all group">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Total Inventory Stock</h3>
            <p className="text-3xl font-extrabold text-emerald-600 mt-2 group-hover:scale-[1.02] transition-transform origin-left">
              {formatNumber(stats.totalInventory)}
            </p>
            <div className="mt-2 text-xs text-slate-500 font-medium">Combined stock units</div>
          </div>

          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md hover:border-rose-400 transition-all group">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Negative Stock Items</h3>
            <p className="text-3xl font-extrabold text-rose-600 mt-2 group-hover:scale-[1.02] transition-transform origin-left">
              {formatNumber(stats.negativeStock)}
            </p>
            <div className="mt-2 text-xs text-rose-500 font-medium">Products with &lt; 0 stock</div>
          </div>

          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md hover:border-amber-400 transition-all group">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Zero Stock Items</h3>
            <p className="text-3xl font-extrabold text-amber-600 mt-2 group-hover:scale-[1.02] transition-transform origin-left">
              {formatNumber(stats.zeroStock)}
            </p>
            <div className="mt-2 text-xs text-amber-600 font-medium">Out of stock variants</div>
          </div>
        </div>

        {/* Sales Performance Section */}
        <div className="mb-10">
          <h2 className="text-xl font-bold tracking-tight text-slate-900 mb-4">Sales Performance Overview</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            <div className="bg-gradient-to-br from-indigo-50/70 to-blue-50/40 p-6 rounded-2xl border border-indigo-200 shadow-sm">
              <h3 className="text-xs font-bold text-indigo-700 uppercase tracking-wider">Total Sales (Net)</h3>
              <p className="text-3xl font-black text-slate-900 mt-2">
                {formatNumber(stats.totalSales)}
              </p>
              <div className="mt-2 text-xs text-indigo-600/80 font-medium">Aggregated net ledger volume</div>
            </div>

            <div className="bg-gradient-to-br from-teal-50/70 to-emerald-50/40 p-6 rounded-2xl border border-teal-200 shadow-sm">
              <h3 className="text-xs font-bold text-teal-700 uppercase tracking-wider">Positive Sales</h3>
              <p className="text-3xl font-black text-teal-700 mt-2">
                {formatNumber(stats.positiveSales)}
              </p>
              <div className="mt-2 text-xs text-teal-600/80 font-medium">Total positive transactions</div>
            </div>

            <div className="bg-gradient-to-br from-rose-50/70 to-orange-50/40 p-6 rounded-2xl border border-rose-200 shadow-sm">
              <h3 className="text-xs font-bold text-rose-700 uppercase tracking-wider">Negative Sales</h3>
              <p className="text-3xl font-black text-rose-700 mt-2">
                {formatNumber(stats.negativeSales)}
              </p>
              <div className="mt-2 text-xs text-rose-600/80 font-medium">Total returns or adjustments</div>
            </div>
          </div>
        </div>

        {/* First Level Categories Cards Section */}
        <div className="mb-6">
          <h2 className="text-xl font-bold tracking-tight text-slate-900 mb-4">First Level Categories Breakdown</h2>
          
          {loading && !hasLoadedOnce ? (
            <div className="bg-white p-10 rounded-2xl border border-slate-200 text-center text-slate-400 font-medium shadow-sm">
              Loading category analytics cards...
            </div>
          ) : categoriesData.length === 0 ? (
            <div className="bg-white p-10 rounded-2xl border border-slate-200 text-center text-slate-400 font-medium shadow-sm">
              No categories found for the selected filters.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {categoriesData.map((cat, idx) => (
                <div 
                  key={idx} 
                  className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md hover:border-slate-300 transition-all flex flex-col justify-between"
                >
                  <div>
                    {/* Category Title & Product Count Badge */}
                    <div className="flex items-start justify-between gap-2 mb-4">
                      <h3 className="text-base font-extrabold text-slate-900 tracking-tight">
                        {cat.categoryName}
                      </h3>
                      <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-600 border border-slate-200 shrink-0">
                        {cat.productCount.toLocaleString()} items
                      </span>
                    </div>

                    {/* Net Sales Highlight */}
                    <div className="bg-slate-50/80 p-3.5 rounded-xl border border-slate-100 mb-4">
                      <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">Net Sales</div>
                      <div className="text-2xl font-black text-slate-900 mt-0.5">
                        {cat.totalSales.toLocaleString()}
                      </div>
                    </div>

                    {/* Sales Sub-metrics */}
                    <div className="grid grid-cols-2 gap-3 mb-4">
                      <div className="bg-emerald-50/50 p-2.5 rounded-xl border border-emerald-100/60">
                        <div className="text-[10px] font-bold text-emerald-700 uppercase tracking-wider">Positive Sales</div>
                        <div className="text-base font-extrabold text-emerald-700 mt-0.5">
                          {cat.positiveSales.toLocaleString()}
                        </div>
                      </div>
                      <div className="bg-rose-50/50 p-2.5 rounded-xl border border-rose-100/60">
                        <div className="text-[10px] font-bold text-rose-700 uppercase tracking-wider">Negative Sales</div>
                        <div className="text-base font-extrabold text-rose-700 mt-0.5">
                          {cat.negativeSales.toLocaleString()}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Stock Sub-metrics Footer */}
                  <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 font-semibold text-rose-600">
                      <span className="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
                      Neg Stock: <strong className="font-bold">{cat.negativeStockCount.toLocaleString()}</strong>
                    </span>
                    <span className="flex items-center gap-1.5 font-semibold text-amber-600">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
                      Zero Stock: <strong className="font-bold">{cat.zeroStockCount.toLocaleString()}</strong>
                    </span>
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