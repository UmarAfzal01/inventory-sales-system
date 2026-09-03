"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import ScopeFields, { EMPTY_SCOPE } from "../ScopeFields";

export default function NewUserPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [scope, setScope] = useState(EMPTY_SCOPE);
  const [options, setOptions] = useState({ branches: [], categories: [] });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/users/options")
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && j.success) setOptions({ branches: j.branches, categories: j.categories });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, scope }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Could not create the user.");
      router.push("/users");
      router.refresh();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

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
      <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 mt-3">Create user</h1>
      <p className="text-sm text-slate-500 font-medium mt-1">
        New accounts are read-only. Choose what they are allowed to see below.
      </p>

      {error && (
        <div className="mt-4 px-4 py-3 rounded-2xl bg-rose-50 border border-rose-200 text-sm font-semibold text-rose-800">
          {error}
        </div>
      )}

      <form onSubmit={submit} className="mt-6 space-y-6">
        <div className="bg-white/70 backdrop-blur-3xl p-6 rounded-3xl border border-white/80 shadow-[0_20px_50px_rgba(0,0,0,0.05)] grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-extrabold text-slate-400 uppercase tracking-wider mb-2">
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="person@example.com"
              className="w-full px-4 py-3 bg-white/80 border border-slate-200/80 rounded-2xl text-sm font-semibold text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>
          <div>
            <label className="block text-xs font-extrabold text-slate-400 uppercase tracking-wider mb-2">
              Password
            </label>
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              className="w-full px-4 py-3 bg-white/80 border border-slate-200/80 rounded-2xl text-sm font-semibold text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          </div>
        </div>

        <div className="bg-white/70 backdrop-blur-3xl p-6 rounded-3xl border border-white/80 shadow-[0_20px_50px_rgba(0,0,0,0.05)]">
          <h2 className="text-sm font-extrabold text-slate-900 mb-1">Access</h2>
          <p className="text-xs text-slate-500 font-medium mb-4">
            The four settings combine — branches <span className="font-bold">and</span> categories,
            not either.
          </p>
          <ScopeFields scope={scope} onChange={setScope} options={options} />
        </div>

        {unrestricted && (
          <p className="text-xs font-semibold text-amber-800 bg-amber-500/10 border border-amber-500/20 rounded-2xl px-4 py-3">
            This user will see all data. Restrict a dimension above if that is not intended.
          </p>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-3 rounded-2xl text-sm font-bold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white transition shadow-sm"
          >
            {saving ? "Creating…" : "Create user"}
          </button>
          <Link
            href="/users"
            className="px-5 py-3 rounded-2xl text-sm font-bold bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 transition"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
