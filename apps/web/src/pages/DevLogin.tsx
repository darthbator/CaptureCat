import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Avatar, Badge, Button, Spinner } from "../components/ui";

interface DevUser {
  id: string;
  name: string;
  email: string;
  role: string;
  suspendedAt: string | null;
}

/** Development-only: pick a seeded user and get a real session (POST /api/dev/login). */
export function DevLoginPage() {
  const users = useQuery({
    queryKey: ["dev-users"],
    queryFn: async () => {
      const res = await fetch("/api/dev/users");
      if (!res.ok) throw new Error("Dev login is disabled on this server.");
      return (await res.json()) as DevUser[];
    },
    retry: false,
  });
  const [busy, setBusy] = useState<string | null>(null);

  const login = async (userId: string) => {
    setBusy(userId);
    const res = await fetch("/api/dev/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    if (res.ok) location.href = "/";
    else setBusy(null);
  };

  const createUser = async () => {
    const res = await fetch("/api/dev/users", { method: "POST" });
    if (res.ok) await login(((await res.json()) as { id: string }).id);
  };

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-fuchsia-500/50 bg-surface p-6">
        <div className="mb-1 text-xs font-bold tracking-widest text-fuchsia-300">DEVELOPMENT ONLY</div>
        <h1 className="text-xl font-semibold mb-4">Dev login</h1>
        {users.isPending && <Spinner />}
        {users.error && <p className="text-sm text-red-300">{users.error.message}</p>}
        <ul className="flex flex-col gap-2">
          {users.data?.map((u) => (
            <li key={u.id}>
              <button
                disabled={!!busy}
                onClick={() => void login(u.id)}
                className="w-full flex items-center gap-3 rounded-lg border border-border bg-surface-2/50 p-2.5 text-left hover:border-fuchsia-400/60 disabled:opacity-60"
              >
                <Avatar name={u.name} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{u.name}</span>
                  <span className="block text-xs text-muted truncate">{u.email}</span>
                </span>
                {u.role === "admin" && <Badge tone="accent">admin</Badge>}
                {u.suspendedAt && <Badge tone="danger">suspended</Badge>}
              </button>
            </li>
          ))}
        </ul>
        {users.data && (
          <Button className="mt-3 w-full" variant="ghost" onClick={() => void createUser()}>
            + New random user
          </Button>
        )}
        <Link to="/login" className="block mt-4 text-sm text-muted hover:text-text">
          ← Back to sign-in
        </Link>
      </div>
    </div>
  );
}
