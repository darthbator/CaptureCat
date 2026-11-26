import { formatBytes, GiB } from "@capturecat/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Avatar, Badge, Button, Empty, PageTitle, Spinner } from "../components/ui";
import { authClient, errorMessage, timeAgo, useTRPC } from "../lib";

export function AdminPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const me = useQuery(trpc.me.queryOptions());
  const [q, setQ] = useState("");
  const users = useQuery(trpc.admin.users.queryOptions({ q: q || undefined }));
  const audit = useQuery(trpc.admin.auditLog.queryOptions());
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: trpc.admin.pathKey() });
  };
  const setQuota = useMutation(trpc.admin.setQuota.mutationOptions({ onSuccess: refresh }));
  const setSuspended = useMutation(trpc.admin.setSuspended.mutationOptions({ onSuccess: refresh }));
  const setRole = useMutation(trpc.admin.setRole.mutationOptions({ onSuccess: refresh }));
  const [impersonateError, setImpersonateError] = useState<string | null>(null);
  const err = setQuota.error ?? setSuspended.error ?? setRole.error;

  if (me.data && me.data.role !== "admin") return <Empty title="Admins only" />;

  return (
    <div className="space-y-8">
      <section>
        <PageTitle actions={<input className="rounded-lg bg-surface border border-border px-3 py-2 text-sm" placeholder="Search users" value={q} onChange={(e) => setQ(e.target.value)} />}>
          Users
        </PageTitle>
        {(err || impersonateError) && <p className="mb-3 text-sm text-red-300">{err ? errorMessage(err) : impersonateError}</p>}
        {users.isPending ? (
          <Spinner />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-surface text-left text-xs text-muted">
                <tr>
                  <th className="p-3">User</th>
                  <th className="p-3">Role</th>
                  <th className="p-3">Storage</th>
                  <th className="p-3">Quota (GB)</th>
                  <th className="p-3">Videos</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody>
                {users.data?.map((u) => (
                  <tr key={u.id} className="border-t border-border">
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        <Avatar name={u.name} image={u.image} />
                        <div className="min-w-0">
                          <div className="font-medium flex items-center gap-1.5">
                            {u.name} {u.suspendedAt && <Badge tone="danger">suspended</Badge>}
                          </div>
                          <div className="text-xs text-muted truncate">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="p-3">
                      <select
                        className="rounded bg-surface-2 border border-border px-2 py-1"
                        value={u.role}
                        disabled={u.id === me.data?.id}
                        onChange={(e) => setRole.mutate({ userId: u.id, role: e.target.value as "user" | "admin" })}
                      >
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td className="p-3 tabular-nums text-muted">{formatBytes(u.usedBytes)}</td>
                    <td className="p-3">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        defaultValue={Math.round((u.quotaBytes / GiB) * 10) / 10}
                        className="w-20 rounded bg-surface-2 border border-border px-2 py-1 tabular-nums"
                        onBlur={(e) => {
                          const gb = Number(e.target.value);
                          if (Number.isFinite(gb) && Math.round(gb * GiB) !== u.quotaBytes) setQuota.mutate({ userId: u.id, quotaBytes: Math.round(gb * GiB) });
                        }}
                        aria-label={`Quota for ${u.name} in GB`}
                      />
                    </td>
                    <td className="p-3 tabular-nums">{u.videoCount}</td>
                    <td className="p-3">
                      {u.id !== me.data?.id && (
                        <div className="flex gap-1.5 justify-end">
                          <Button size="sm" onClick={() => setSuspended.mutate({ userId: u.id, suspended: !u.suspendedAt })}>
                            {u.suspendedAt ? "Unsuspend" : "Suspend"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Sign in as this user for 30 minutes (audit-logged)"
                            onClick={async () => {
                              const res = await authClient.admin.impersonateUser({ userId: u.id });
                              if (res.error) setImpersonateError(res.error.message ?? "Couldn't impersonate");
                              else location.href = "/";
                            }}
                          >
                            Impersonate
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Audit log</h2>
        <ul className="rounded-xl border border-border divide-y divide-border text-sm">
          {audit.data?.length === 0 && <li className="p-3 text-muted">No admin actions yet.</li>}
          {audit.data?.map((a) => (
            <li key={a.id} className="p-3 flex flex-wrap gap-x-3 gap-y-1">
              <span className="font-mono text-xs text-accent">{a.action}</span>
              <span>{a.actorName ?? "system"}</span>
              <span className="text-muted">→ {a.targetId}</span>
              {a.data != null && <span className="text-muted text-xs">{JSON.stringify(a.data)}</span>}
              <span className="ml-auto text-xs text-muted">{timeAgo(String(a.createdAt))}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
