"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import ScopeFields, { EMPTY_SCOPE } from "../../ScopeFields";

export default function EditUserPage({ params }) {
  const { id } = use(params);
  const router = useRouter();

  const [user, setUser] = useState(null);
  const [scope, setScope] = useState(EMPTY_SCOPE);
  const [password, setPassword] = useState("");
  const [options, setOptions] = useState({ branches: [], categories: [] });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/users/${id}`).then((r) => r.json()),
      fetch("/api/users/options").then((r) => r.json()),
    ])
      .then(([u, o]) => {
        if (cancelled) return;
        if (!u.success) {
          setError(u.error || "Could not load that user.");
          return;
        }
        setUser(u.user);
        setScope({ ...EMPTY_SCOPE, ...(u.user.scope ?? {}) });
        if (o.success) setOptions({ branches: o.branches, categories: o.categories });
      })
      .catch(() => {
        if (!cancelled) setError("Could not load that user.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const call = async (body, message, { back = false } = {}) => {
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "That did not work.");
      setUser(json.user);
      setNotice(message);
      if (back) {
        router.push("/users");
        router.refresh();
      }
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    }
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    const body = { scope };
    if (password) body.newPassword = password;
    const ok = await call(body, "Saved.", { back: true });
    if (ok) setPassword("");
    setSaving(false);
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${user.email}? This cannot be undone.`)) return;
    const res = await fetch(`/api/users/${id}`, { method: "DELETE" });
    const json = await res.json();
    if (!json.success) {
      setError(json.error || "Could not delete that user.");
      return;
    }
    router.push("/users");
    router.refresh();
  };

  if (error && !user) {
    return (
      <div className="p-6 md:p-8 max-w-3xl mx-auto w-full">
        <Link href="/users" className="text-xs font-bold text-slate-500 hover:text-slate-800">
          ← Back to users
        </Link>
        <div className="mt-4 px-4 py-3 rounded-2xl bg-rose-50 border border-rose-200 text-sm font-semibold text-rose-800">
          {error}
        </div>
      </div>
    );
  }

  if (!user) {
    return <div className="p-8 text-sm font-semibold text-slate-400">Loading…</div>;
  }

  const isAdmin = user.role === "admin";
  const unrestricted =
    !scope.branches.length &&
    !scope.categories.length &&
    !scope.subCategories.length &&
    !scope.products.length;

  return (
    <div className="p-6 md:p-8 max-w-3xl mx-auto w-full overflow-y-auto">
      <Link href="/users" className="text-xs font-bold text-slate-500 hover:text-slate-800">
        ← Back to users
      </Link>
      <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 mt-3 break-all">
        {user.email}
      </h1>
      <p className="text-sm text-slate-500 font-medium mt-1">
        {isAdmin
          ? "The admin account. It has full access and cannot be restricted."
          : "Read-only account. Choose what it is allowed to see below."}
      </p>

      {error && (
        <div className="mt-4 px-4 py-3 rounded-2xl bg-rose-50 border border-rose-200 text-sm font-semibold text-rose-800">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-4 px-4 py-3 rounded-2xl bg-emerald-50 border border-emerald-200 text-sm font-semibold text-emerald-800">
          {notice}
        </div>
      )}

      <form onSubmit={save} className="mt-6 space-y-6">
        <div className="bg-white/70 backdrop-blur-3xl p-6 rounded-3xl border border-white/80 shadow-[0_20px_50px_rgba(0,0,0,0.05)] grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-extrabold text-slate-400 uppercase tracking-wider mb-2">
              Email
            </label>
            <input
              value={user.email}
              disabled
              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-semibold text-slate-500"
            />
            <p className="text-[11px] text-slate-400 font-medium mt-1.5">
              Email cannot be changed — create a new account instead.
            </p>
          </div>
          <div>
            <label className="block text-xs font-extrabold text-slate-400 uppercase tracking-wider mb-2">
              New password
            </label>
            <input
              type="password"
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank to keep current"
              className="w-full px-4 py-3 bg-white/80 border border-slate-200/80 rounded-2xl text-sm font-semibold text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>
        </div>

        {!isAdmin && (
          <div className="bg-white/70 backdrop-blur-3xl p-6 rounded-3xl border border-white/80 shadow-[0_20px_50px_rgba(0,0,0,0.05)]">
            <h2 className="text-sm font-extrabold text-slate-900 mb-1">Access</h2>
            <p className="text-xs text-slate-500 font-medium mb-4">
              The four settings combine — branches <span className="font-bold">and</span> categories,
              not either.
            </p>
            <ScopeFields scope={scope} onChange={setScope} options={options} />
            {unrestricted && (
              <p className="text-xs font-semibold text-amber-800 bg-amber-500/10 border border-amber-500/20 rounded-2xl px-4 py-3 mt-4">
                This user will see all data.
              </p>
            )}
          </div>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-3 rounded-2xl text-sm font-bold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white transition shadow-sm"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
          <Link
            href="/users"
            className="px-5 py-3 rounded-2xl text-sm font-bold bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 transition"
          >
            Cancel
          </Link>
        </div>
      </form>

      {!isAdmin && (
        <div className="mt-8 bg-white/70 backdrop-blur-3xl p-6 rounded-3xl border border-rose-200/60">
          <h2 className="text-sm font-extrabold text-slate-900">Account status</h2>
          <p className="text-xs text-slate-500 font-medium mt-1 mb-4">
            Disabling keeps the record and the history of what they were given access to. Deleting
            removes both.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() =>
                call(
                  { disabled: !user.disabled },
                  user.disabled ? "Account re-enabled." : "Account disabled."
                )
              }
              className="px-4 py-2.5 rounded-2xl text-xs font-bold bg-amber-500/10 hover:bg-amber-500/20 text-amber-800 transition"
            >
              {user.disabled ? "Re-enable account" : "Disable account"}
            </button>
            <button
              type="button"
              onClick={remove}
              className="px-4 py-2.5 rounded-2xl text-xs font-bold bg-rose-500/10 hover:bg-rose-500/20 text-rose-800 transition"
            >
              Delete account
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
