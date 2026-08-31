"use client";
import { useCallback, useEffect, useState } from "react";

const ROLE_LABEL = { admin: "Admin", viewer: "Viewer" };

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("viewer");
  const [creating, setCreating] = useState(false);

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

  // Every mutation reloads rather than patching local state, so the table can
  // never drift from what the server actually stored.
  const act = async (fn, successMessage) => {
    setError("");
    setNotice("");
    try {
      const res = await fn();
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "That did not work.");
      setNotice(successMessage);
      await load();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    }
  };

  const createUser = async (e) => {
    e.preventDefault();
    setCreating(true);
    const ok = await act(
      () =>
        fetch("/api/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, role }),
        }),
      `Created ${email}.`
    );
    if (ok) {
      setEmail("");
      setPassword("");
      setRole("viewer");
    }
    setCreating(false);
  };

  const patch = (id, body, message) =>
    act(
      () =>
        fetch(`/api/users/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      message
    );

  const remove = (u) => {
    if (!window.confirm(`Delete ${u.email}? This cannot be undone.`)) return;
    act(() => fetch(`/api/users/${u.id}`, { method: "DELETE" }), `Deleted ${u.email}.`);
  };

  const resetPassword = (u) => {
    const newPassword = window.prompt(`New password for ${u.email} (at least 8 characters):`);
    if (!newPassword) return;
    patch(u.id, { newPassword }, `Password reset for ${u.email}.`);
  };

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto w-full overflow-y-auto">
      <h1 className="text-3xl font-extrabold tracking-tight text-slate-900">Users</h1>
      <p className="text-sm text-slate-500 font-medium mt-1">
        Admins upload data and manage accounts. Viewers can only read the dashboard.
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
        onSubmit={createUser}
        className="mt-6 bg-white/70 backdrop-blur-3xl p-6 rounded-3xl border border-white/80 shadow-[0_20px_50px_rgba(0,0,0,0.05)] grid grid-cols-1 md:grid-cols-4 gap-4 items-end"
      >
        <div className="md:col-span-2">
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
        <div>
          <label className="block text-xs font-extrabold text-slate-400 uppercase tracking-wider mb-2">
            Role
          </label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="w-full px-4 py-3 bg-white/80 border border-slate-200/80 rounded-2xl text-sm font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
          >
            <option value="viewer">Viewer — read only</option>
            <option value="admin">Admin — can upload and manage users</option>
          </select>
        </div>
        <div className="md:col-span-4">
          <button
            type="submit"
            disabled={creating}
            className="px-5 py-3 rounded-2xl text-sm font-bold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white transition shadow-sm"
          >
            {creating ? "Creating…" : "Create user"}
          </button>
        </div>
      </form>

      <div className="mt-6 bg-white/70 backdrop-blur-3xl rounded-3xl border border-white/80 shadow-[0_20px_50px_rgba(0,0,0,0.05)] overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-extrabold text-slate-400 uppercase tracking-wider">
              <th className="px-5 py-4">Email</th>
              <th className="px-5 py-4">Role</th>
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
                      <span
                        className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                          u.role === "admin"
                            ? "bg-blue-500/10 text-blue-700"
                            : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {ROLE_LABEL[u.role] ?? u.role}
                      </span>
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
                      <div className="flex flex-wrap gap-2 justify-end">
                        <button
                          type="button"
                          onClick={() => resetPassword(u)}
                          className="px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700"
                        >
                          Reset password
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            patch(
                              u.id,
                              { role: u.role === "admin" ? "viewer" : "admin" },
                              `${u.email} is now ${u.role === "admin" ? "a viewer" : "an admin"}.`
                            )
                          }
                          disabled={self}
                          className="px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 disabled:opacity-40 text-slate-700"
                        >
                          Make {u.role === "admin" ? "viewer" : "admin"}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            patch(
                              u.id,
                              { disabled: !u.disabled },
                              `${u.email} ${u.disabled ? "re-enabled" : "disabled"}.`
                            )
                          }
                          disabled={self}
                          className="px-3 py-1.5 rounded-xl text-xs font-bold bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-40 text-amber-800"
                        >
                          {u.disabled ? "Enable" : "Disable"}
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(u)}
                          disabled={self}
                          className="px-3 py-1.5 rounded-xl text-xs font-bold bg-rose-500/10 hover:bg-rose-500/20 disabled:opacity-40 text-rose-800"
                        >
                          Delete
                        </button>
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
