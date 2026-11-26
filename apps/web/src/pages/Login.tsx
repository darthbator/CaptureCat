import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { Button, Spinner } from "../components/ui";
import { authClient, fetchPublicConfig } from "../lib";

const LABELS: Record<string, string> = {
  google: "Continue with Google",
  github: "Continue with GitHub",
  twitch: "Continue with Twitch",
  discord: "Continue with Discord",
  mock: "Continue with Mock OAuth (dev)",
};

export function LoginPage() {
  const { next } = useSearch({ from: "/login" });
  const cfg = useQuery({ queryKey: ["public-config"], queryFn: fetchPublicConfig, staleTime: Infinity });
  const [error, setError] = useState<string | null>(null);
  const callbackURL = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

  const signIn = async (provider: string) => {
    setError(null);
    if (provider === "mock") {
      // Generic OAuth (mock OIDC server, dev compose only).
      const res = await authClient.$fetch<{ url?: string }>("/sign-in/oauth2", { method: "POST", body: { providerId: "mock", callbackURL } });
      if (res.data?.url) location.href = res.data.url;
      else setError("Sign-in failed");
      return;
    }
    const res = await authClient.signIn.social({ provider: provider as "google", callbackURL });
    if (res?.error) setError(res.error.message ?? "Sign-in failed");
  };

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-7 shadow-2xl">
        <div className="flex items-center gap-3 mb-6">
          <img src="/favicon.svg" alt="" className="h-10 w-10" />
          <div>
            <h1 className="text-xl font-bold">Capture Cat</h1>
            <p className="text-sm text-muted">Stream, record and annotate video.</p>
          </div>
        </div>
        {cfg.isPending ? (
          <Spinner />
        ) : (
          <div className="flex flex-col gap-2">
            {cfg.data?.providers.map((p) => (
              <Button key={p} variant="secondary" className="w-full py-2.5" onClick={() => void signIn(p)}>
                {LABELS[p] ?? `Continue with ${p}`}
              </Button>
            ))}
            {cfg.data && cfg.data.providers.length === 0 && (
              <p className="text-sm text-muted">
                No sign-in providers are configured. Set <code className="text-text">GOOGLE_CLIENT_ID</code>/<code className="text-text">GITHUB_CLIENT_ID</code> (and secrets) on the server.
              </p>
            )}
            {cfg.data?.devLogin && (
              <Link to="/dev/login" className="mt-3 rounded-lg border border-dashed border-fuchsia-500/60 px-3 py-2.5 text-center text-sm text-fuchsia-300 hover:bg-fuchsia-500/10">
                Dev login (development only)
              </Link>
            )}
          </div>
        )}
        {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
        <p className="mt-6 text-xs text-muted">Sign-in is required to watch, stream and annotate.</p>
      </div>
    </div>
  );
}
