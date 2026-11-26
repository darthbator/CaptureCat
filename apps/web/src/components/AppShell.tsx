import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { authClient, fetchPublicConfig, useTRPC } from "../lib";
import { Avatar, Spinner } from "./ui";

/** Signed-in layout: header, banners, app-wide live updates. */
export function AppShell() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const me = useQuery(trpc.me.queryOptions());
  const cfg = useQuery({ queryKey: ["public-config"], queryFn: fetchPublicConfig, staleTime: Infinity });
  const [menuOpen, setMenuOpen] = useState(false);

  // App-wide events: refresh lists when videos change (status, progress, publish, live).
  useEffect(() => {
    if (!me.data) return;
    const es = new EventSource("/api/events");
    let pending: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        void qc.invalidateQueries({ queryKey: trpc.videos.pathKey() });
        void qc.invalidateQueries({ queryKey: trpc.me.queryKey() });
      }, 300);
    };
    es.addEventListener("video.updated", refresh);
    es.addEventListener("video.progress", refresh);
    return () => es.close();
  }, [me.data, qc, trpc]);

  if (me.isPending) {
    return (
      <div className="min-h-screen grid place-items-center">
        <Spinner />
      </div>
    );
  }
  if (!me.data) return null; // 401 → redirected to /login by the query cache

  const u = me.data;
  const nav = [
    { to: "/", label: "Feed" },
    { to: "/browse", label: "Browse" },
    { to: "/library", label: "Library" },
    { to: "/studio", label: "Go live" },
    ...(u.role === "admin" ? [{ to: "/admin", label: "Admin" }] : []),
  ] as const;

  return (
    <div className="min-h-screen flex flex-col">
      {cfg.data?.devLogin && (
        <div className="bg-fuchsia-700 text-white text-xs text-center py-1 font-semibold tracking-wide">DEV LOGIN ENABLED (development only)</div>
      )}
      {u.impersonatedBy && (
        <div className="bg-amber-500 text-bg text-sm text-center py-1.5 font-medium">
          You are impersonating {u.name}.{" "}
          <button className="underline font-semibold" onClick={async () => (await authClient.admin.stopImpersonating(), (location.href = "/admin"))}>
            Stop impersonating
          </button>
        </div>
      )}
      {u.suspended && (
        <div className="bg-red-900/80 text-red-100 text-sm text-center py-1.5">
          Your account is suspended. You can watch videos but can't stream, upload or annotate.
        </div>
      )}
      <header className="sticky top-0 z-30 border-b border-border bg-bg/90 backdrop-blur">
        <div className="mx-auto max-w-[1600px] px-4 h-14 flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2 font-bold tracking-tight shrink-0">
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            <span className="hidden sm:inline">Capture Cat</span>
          </Link>
          <nav className="flex items-center gap-1 overflow-x-auto scroll-thin">
            {nav.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                activeOptions={{ exact: n.to === "/" }}
                className="px-3 py-1.5 rounded-lg text-sm text-muted hover:text-text whitespace-nowrap"
                activeProps={{ className: "!text-text bg-surface-2" }}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto relative">
            <button className="flex items-center gap-2 rounded-full p-0.5 hover:bg-surface-2" onClick={() => setMenuOpen((o) => !o)} aria-label="Account menu">
              <Avatar name={u.name} image={u.image} size={32} />
            </button>
            {menuOpen && (
              <div className="absolute right-0 mt-2 w-56 rounded-xl border border-border bg-surface shadow-2xl p-2 text-sm" onMouseLeave={() => setMenuOpen(false)}>
                <div className="px-2 py-1.5">
                  <div className="font-medium truncate">{u.name}</div>
                  <div className="text-xs text-muted truncate">{u.email}</div>
                </div>
                <button
                  className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-surface-2"
                  onClick={async () => {
                    await authClient.signOut();
                    location.href = "/login";
                  }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <main className="flex-1 mx-auto w-full max-w-[1600px] px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
