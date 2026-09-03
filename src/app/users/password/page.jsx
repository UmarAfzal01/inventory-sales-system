"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * Change your own password.
 *
 * Deliberately not the admin reset used for other accounts: this asks for the
 * current password as well. The session already proves who you are, but an
 * unattended logged-in browser should not be enough to lock the owner out.
 */
export default function ChangePasswordPage() {
  const [me, setMe] = useState(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && j.success) setMe(j.user);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setNotice("");
    if (next !== confirm) {
      setError("The two new passwords do not match.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Could not change the password.");
      setNotice("Password changed. It applies the next time you sign in.");
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const field =
    "w-full px-4 py-3 bg-white/80 border border-slate-200/80 rounded-2xl text-sm font-semibold text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50";

  return (
    <div className="p-6 md:p-8 max-w-xl mx-auto w-full overflow-y-auto">
      <Link href="/users" className="text-xs font-bold text-slate-500 hover:text-slate-800">
        ← Back to users
      </Link>
      <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 mt-3">Change password</h1>
      <p className="text-sm text-slate-500 font-medium mt-1 break-all">
        {me ? me.email : "Your account"}
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

      <form
        onSubmit={submit}
        className="mt-6 bg-white/70 backdrop-blur-3xl p-6 rounded-3xl border border-white/80 shadow-[0_20px_50px_rgba(0,0,0,0.05)] space-y-4"
      >
        <div>
          <label className="block text-xs font-extrabold text-slate-400 uppercase tracking-wider mb-2">
            Current password
          </label>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className={field}
          />
        </div>
        <div>
          <label className="block text-xs font-extrabold text-slate-400 uppercase tracking-wider mb-2">
            New password
          </label>
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="At least 8 characters"
            className={field}
          />
        </div>
        <div>
          <label className="block text-xs font-extrabold text-slate-400 uppercase tracking-wider mb-2">
            Confirm new password
          </label>
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={field}
          />
        </div>
        <div className="flex gap-3 pt-1">
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-3 rounded-2xl text-sm font-bold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white transition shadow-sm"
          >
            {saving ? "Saving…" : "Change password"}
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
