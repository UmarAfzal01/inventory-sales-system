"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import FileUpload from "@/components/FileUpload";

export default function ClientLayoutWrapper({ children }) {
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isUploadOpen, setIsUploadOpen] = useState(false);

  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentBranch = searchParams.get("branch");

  // Who is signed in, so the chrome can hide what this account cannot do.
  // Cosmetic only — every route enforces the same rule server-side, because a
  // hidden button is not a permission.
  const [me, setMe] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.success) {
          setMe(j.user);
          return;
        }
        // A session the server will not accept — expired, signed with a
        // rotated secret, or left over from before sessions were signed.
        // Without this the page just renders without the admin controls, which
        // looks like a permissions bug rather than a login that lapsed.
        router.replace("/login");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [router]);
  const isAdminUser = me?.role === "admin";

  // Changing branch must keep every other parameter — category, sub-category,
  // dates, type, status. Linking to a bare /dashboard?branch=X threw the user
  // back to the top level and silently dropped their filters.
  const branchHref = (name) => {
    const params = new URLSearchParams(searchParams.toString());
    if (name) params.set("branch", name);
    else params.delete("branch");
    params.delete("page"); // a different branch means a different result set
    const qs = params.toString();
    return qs ? `/dashboard?${qs}` : "/dashboard";
  };

  const [branchesData, setBranchesData] = useState([]);
  const [loadingBranches, setLoadingBranches] = useState(true);

  // Check if we are on the login or root route
  const isAuthRoute = pathname === "/login" || pathname === "/";

  // Fetch branch list and query stock metrics per branch to display real counts
  useEffect(() => {
    if (isAuthRoute) return;

    const fetchSidebarData = async () => {
      try {
        const res = await fetch("/api/dashboard").then((r) => r.json());
        
        if (res.success && res.filtersList?.branches) {
          const branchList = res.filtersList.branches;

          const detailedBranches = await Promise.all(
            branchList.map(async (branchName) => {
              try {
                const branchRes = await fetch(`/api/dashboard?branch=${encodeURIComponent(branchName)}`).then((r) => r.json());
                return {
                  name: branchName,
                  negativeStock: branchRes.success && branchRes.stats ? branchRes.stats.negativeStock : 0,
                  zeroStock: branchRes.success && branchRes.stats ? branchRes.stats.zeroStock : 0,
                };
              } catch {
                return { name: branchName, negativeStock: 0, zeroStock: 0 };
              }
            })
          );

          setBranchesData(detailedBranches);
        }
      } catch (err) {
        console.error("Failed to load branch stock metrics for sidebar:", err);
      } finally {
        setLoadingBranches(false);
      }
    };

    fetchSidebarData();
  }, [isAuthRoute]);

  const handleSignOut = async () => {
    try {
      // The session cookie is httpOnly, so document.cookie cannot remove it —
      // the previous version appeared to sign out, then middleware saw the
      // still-valid cookie and sent you straight back to the dashboard.
      // Only the server can expire it.
      await fetch("/api/auth/logout", { method: "POST" });
    } catch (err) {
      console.error("Failed to sign out:", err);
    } finally {
      router.push("/login");
      router.refresh();
    }
  };

  // 🌟 GUARD: If it's an auth route, return full-width children immediately without any dashboard layout chrome
  if (isAuthRoute) {
    return <div className="w-screen h-screen overflow-hidden flex flex-col">{children}</div>;
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden relative">
      {/* PERSISTENT SIDEBAR - Deep Frosted Glassmorphism Theme */}
      <aside 
        className={`bg-white/25 backdrop-blur-2xl border-r border-white/40 shadow-[20px_0_50px_rgba(0,0,0,0.04)] flex flex-col shrink-0 select-none relative overflow-hidden h-full transition-all duration-300 ${
          sidebarOpen ? "w-80" : "w-0 opacity-0 pointer-events-none md:w-0"
        }`}
      >
        {/* Vibrant Ambient Glass Orbs */}
        <div className="absolute -top-24 -left-24 w-56 h-56 bg-blue-500/20 rounded-full blur-3xl pointer-events-none"></div>
        <div className="absolute top-1/2 -right-24 w-56 h-56 bg-indigo-500/20 rounded-full blur-3xl pointer-events-none"></div>

        <div className="relative z-10 flex flex-col h-full w-80 overflow-y-auto">
          <div>
            {/* Sidebar Top Badge */}
            <div className="p-6 border-b border-white/25 flex items-center justify-between">
              <div>
                <span className="inline-block px-3 py-1 bg-white/40 backdrop-blur-md border border-white/60 text-blue-700 text-[10px] font-extrabold rounded-full uppercase tracking-wider shadow-sm">
                  Headquarter
                </span>
                <h2 className="text-base font-extrabold text-slate-900 mt-2.5 tracking-tight">Rainbow AI Portal</h2>
                <p className="text-xs text-slate-500 font-medium mt-0.5">
                  {me ? me.email : "Signing in…"}
                </p>
                {me && (
                  <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wider ${
                    isAdminUser
                      ? "bg-blue-500/10 text-blue-700"
                      : "bg-slate-100 text-slate-600"
                  }`}>
                    {isAdminUser ? "Admin" : "Viewer"}
                  </span>
                )}
              </div>
            </div>

            {/* Navigation Menu */}
            <div className="p-4 space-y-6">
              <div>
                <div className="text-[11px] font-extrabold uppercase tracking-wider text-slate-400 px-3 mb-2">Overview</div>
                <div className="space-y-1">
                  <Link 
                    href="/dashboard" 
                    className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-2xl text-xs font-bold backdrop-blur-xl transition ${
                      pathname === "/dashboard" && !currentBranch
                        ? "bg-white/50 border border-white/70 text-blue-700 shadow-[0_8px_20px_rgba(37,99,235,0.1)]" 
                        : "text-slate-600 hover:bg-white/20 hover:text-slate-900 border border-transparent"
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full ${pathname === "/dashboard" && !currentBranch ? "bg-blue-600 shadow-[0_0_8px_rgba(37,99,235,0.8)]" : "bg-slate-400"}`}></span>
                    Inventory Overview
                  </Link>
                </div>
              </div>

              {/* Branch-wise Negative & Zero Stock List */}
              <div>
                <div className="text-[11px] font-extrabold uppercase tracking-wider text-slate-400 px-3 mb-2">
                  Branches Stock Breakdown
                </div>
                <div className="space-y-2 px-1">
                  <Link 
                    href={branchHref(null)}
                    className={`px-3.5 py-2.5 backdrop-blur-xl rounded-2xl border transition duration-200 flex items-center justify-between ${
                      !currentBranch 
                        ? "bg-blue-600/10 border-blue-500/30 text-blue-700 shadow-sm" 
                        : "bg-white/30 border-white/50 hover:bg-white/50 text-slate-800"
                    }`}
                  >
                    <span className="text-xs font-extrabold truncate">
                      🌐 All Branches (Global)
                    </span>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg bg-white/50 border border-white/80">
                      View All
                    </span>
                  </Link>

                  {loadingBranches ? (
                    <div className="px-3 py-2 text-xs text-slate-400 font-semibold">Loading branch metrics...</div>
                  ) : branchesData.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-slate-400 font-semibold">No branch data available.</div>
                  ) : (
                    branchesData.map((branch, idx) => {
                      const isSelected = currentBranch === branch.name;
                      return (
                        <Link 
                          key={idx} 
                          href={branchHref(branch.name)}
                          className={`px-3.5 py-2.5 backdrop-blur-xl rounded-2xl border transition duration-200 flex items-center justify-between ${
                            isSelected 
                              ? "bg-blue-600/10 border-blue-500/30 shadow-sm ring-1 ring-blue-500/30" 
                              : "bg-white/30 border-white/50 hover:bg-white/50"
                          }`}
                        >
                          <span className={`text-xs font-extrabold truncate max-w-[130px] ${isSelected ? "text-blue-700" : "text-slate-800"}`}>
                            {branch.name}
                          </span>
                          
                          <div className="flex items-center gap-1.5 text-xs">
                            <div className="bg-rose-500/10 backdrop-blur-md border border-rose-500/20 text-rose-700 px-2 py-1 rounded-xl font-black min-w-[28px] text-center shadow-xs">
                              {branch.negativeStock.toLocaleString()}
                            </div>
                            <div className="bg-amber-500/10 backdrop-blur-md border border-amber-500/20 text-amber-700 px-2 py-1 rounded-xl font-black min-w-[28px] text-center shadow-xs">
                              {branch.zeroStock.toLocaleString()}
                            </div>
                          </div>
                        </Link>
                      );
                    })
                  )}
                </div>
              </div>

            </div>
          </div>

          {/* Bottom Actions / Sign Out */}
          <div className="mt-auto p-4 border-t border-white/20 bg-white/10 backdrop-blur-xl">
            <button 
              onClick={handleSignOut}
              className="w-full py-3 bg-white/40 hover:bg-white/70 border border-white/50 text-slate-700 font-bold text-xs rounded-2xl transition-all shadow-sm flex items-center justify-center gap-2 backdrop-blur-md cursor-pointer"
            >
              <span>Sign Out</span>
            </button>
          </div>
        </div>
      </aside>

      {/* MAIN PAGE CONTENT */}
      <main className="flex-1 min-w-0 h-full overflow-y-auto flex flex-col relative">
        {/* Top Header Bar */}
        <div className="sticky top-0 z-40 px-6 py-3 bg-white/25 backdrop-blur-xl border-b border-white/30 flex items-center justify-between">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="px-3.5 py-1.5 bg-white/40 hover:bg-white/70 border border-white/50 rounded-xl text-xs font-bold text-slate-700 shadow-sm transition flex items-center gap-2 backdrop-blur-md cursor-pointer"
          >
            <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            <span>{sidebarOpen ? "Hide Sidebar" : "Show Sidebar"}</span>
          </button>

          {/* Admin actions, grouped so they read as one cluster rather than
              being spread apart by the header's justify-between. */}
          <div className="flex items-center gap-3">
          {isAdminUser && (
            <Link
              href="/users"
              className="group relative px-5 py-2.5 bg-gradient-to-r from-white/60 via-white/40 to-blue-50/50 hover:from-white/80 hover:to-blue-100/60 text-blue-900 font-extrabold text-xs rounded-2xl backdrop-blur-2xl border border-white/80 shadow-[0_8px_25px_rgba(37,99,235,0.12),inset_0_1px_1px_rgba(255,255,255,0.9)] hover:shadow-[0_12px_30px_rgba(37,99,235,0.22),inset_0_1px_1px_rgba(255,255,255,1)] transition-all duration-300 transform hover:-translate-y-0.5 active:translate-y-0 flex items-center gap-2.5 overflow-hidden"
            >
              <div className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-white to-transparent opacity-80"></div>

              <span className="w-6 h-6 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 text-white flex items-center justify-center shadow-[0_4px_12px_rgba(37,99,235,0.3)] group-hover:scale-110 transition-transform duration-300">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
              </span>

              <span className="tracking-tight font-bold">Users</span>
            </Link>
          )}

          {/* UPLOAD BUTTON - admins only; viewers are read-only. */}
          {isAdminUser && (
          <button
            onClick={() => setIsUploadOpen(true)}
            className="group relative px-5 py-2.5 bg-gradient-to-r from-white/60 via-white/40 to-blue-50/50 hover:from-white/80 hover:to-blue-100/60 text-blue-900 font-extrabold text-xs rounded-2xl backdrop-blur-2xl border border-white/80 shadow-[0_8px_25px_rgba(37,99,235,0.12),inset_0_1px_1px_rgba(255,255,255,0.9)] hover:shadow-[0_12px_30px_rgba(37,99,235,0.22),inset_0_1px_1px_rgba(255,255,255,1)] transition-all duration-300 transform hover:-translate-y-0.5 active:translate-y-0 flex items-center gap-2.5 overflow-hidden cursor-pointer"
          >
            <div className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-white to-transparent opacity-80"></div>
            
            <span className="w-6 h-6 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 text-white flex items-center justify-center shadow-[0_4px_12px_rgba(37,99,235,0.3)] group-hover:scale-110 transition-transform duration-300">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
            </span>

            <span className="tracking-tight font-bold">Upload Excel Data</span>
          </button>
          )}
          </div>
        </div>

        {children}
      </main>

      {/* RIGHT-SIDE SLIDE-OVER DRAWER OVERLAY */}
      {isUploadOpen && isAdminUser && (
        <div 
          className="fixed inset-0 z-50 bg-slate-900/30 backdrop-blur-sm transition-opacity"
          onClick={() => setIsUploadOpen(false)}
        />
      )}

      {/* RIGHT-SIDE PANEL (Slide-over drawer) */}
      <div 
        className={`fixed top-0 right-0 h-full w-full max-w-lg z-50 bg-white/80 backdrop-blur-3xl border-l border-white/80 shadow-2xl transition-transform duration-300 ease-in-out transform ${
          isUploadOpen ? "translate-x-0" : "translate-x-full"
        } flex flex-col`}
      >
        <div className="p-6 border-b border-white/40 flex items-center justify-between bg-white/40 backdrop-blur-md">
          <div>
            <h2 className="text-xl font-extrabold text-gray-900 tracking-tight">
              Data Management & Upload
            </h2>
            <p className="text-xs text-gray-600 mt-0.5">
              Easily upload and merge your multi-day sales or daily inventory sheets.
            </p>
          </div>
          <button
            onClick={() => setIsUploadOpen(false)}
            className="w-9 h-9 rounded-full bg-white/60 hover:bg-white text-gray-700 flex items-center justify-center transition shadow-sm border border-white/60 cursor-pointer"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          <FileUpload 
            isOpen={true} 
            onClose={() => setIsUploadOpen(false)} 
            isDrawerMode={true} 
          />
        </div>
      </div>
    </div>
  );
}