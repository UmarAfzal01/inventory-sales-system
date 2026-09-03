"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { describeScope } from "@/lib/scope";

const ROLE_LABEL = { admin: "Admin", viewer: "Viewer" };

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");


  // setLoading is deliberately not called here. Doing so made the effect below
  // set state synchronously on mount, which cascades an extra render; the
  // initial state is already `true`, and the reloads after a mutation are fast
  // enough not to need a spinner.
  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([
        fetch("/api/users").then((r) => r.json()),
        fetch("/api/auth/me").then((r) => r.json()),
      ]);
      if (!a.success) throw new Error(a.error || "Could not load users.");
      setUsers(a.users);
      setMe(b.success ? b.user : null);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Deferred by a microtask so nothing sets state during the effect itself,
  // and guarded so a fast unmount does not write to a gone component.
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto w-full overflow-y-auto">
      <h1 className="text-3xl font-extrabold tracking-tight text-slate-900">Users</h1>
      <p className="text-sm text-slate-500 font-medium mt-1">
        There is one admin account. Everyone created here is read-only, and can be
        restricted to particular branches, categories and products.
      </p>

      {error && (
        <div className="mt-4 px-4 py-3 rounded-2xl bg-rose-50 border border-rose-200 text-sm font-semibold text-rose-800">
          {error}
        </div>
      )}

      <div className="mt-6">
        <Link
          href="/users/new"
          className="inline-flex px-5 py-3 rounded-2xl text-sm font-bold bg-blue-600 hover:bg-blue-700 text-white transition shadow-sm"
        >
          Create user
        </Link>
      </div>

      <div className="mt-6 bg-white/70 backdrop-blur-3xl rounded-3xl border border-white/80 shadow-[0_20px_50px_rgba(0,0,0,0.05)] overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-extrabold text-slate-400 uppercase tracking-wider">
              <th className="px-5 py-4">Email</th>
              <th className="px-5 py-4">Access</th>
              <th className="px-5 py-4">Status</th>
              <th className="px-5 py-4">Last login</th>
              <th className="px-5 py-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-5 py-6 text-slate-400 font-semibold">
                  Loading…
                </td>
              </tr>
            )}
            {!loading &&
              users.map((u) => {
                const self = me && me.id === u.id;
                return (
                  <tr key={u.id} className="border-t border-slate-100">
                    <td className="px-5 py-4 font-bold text-slate-800">
                      {u.email}
                      {self && <span className="ml-2 text-xs text-slate-400">(you)</span>}
                    </td>
                    <td className="px-5 py-4">
                      {u.role === "admin" ? (
                        <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-blue-500/10 text-blue-700">
                          {ROLE_LABEL.admin} — full access
                        </span>
                      ) : (
                        <span className="text-xs font-semibold text-slate-600">
                          {describeScope(u.scope)}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-4">
                      <span
                        className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                          u.disabled
                            ? "bg-amber-500/10 text-amber-700"
                            : "bg-emerald-500/10 text-emerald-700"
                        }`}
                      >
                        {u.disabled ? "Disabled" : "Active"}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-slate-500 font-semibold">
                      {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "Never"}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex justify-end">
                        {self ? (
                          <Link
                            href="/users/password"
                            className="px-4 py-2 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 transition"
                          >
                            Change password
                          </Link>
                        ) : (
                          <Link
                            href={`/users/${u.id}/edit`}
                            className="px-4 py-2 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 transition"
                          >
                            Edit
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
