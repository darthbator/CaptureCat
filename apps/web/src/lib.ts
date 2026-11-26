import type { AppRouter } from "@capturecat/api/router";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export type Outputs = inferRouterOutputs<AppRouter>;
export type VideoDto = Outputs["videos"]["get"];
export type AnnotationDto = Outputs["annotations"]["list"][number];
export type Me = Outputs["me"];

export function isUnauthorized(err: unknown): boolean {
  return err instanceof TRPCClientError && err.data?.code === "UNAUTHORIZED";
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, err) => !isUnauthorized(err) && !(err instanceof TRPCClientError && err.data?.httpStatus < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
  queryCache: new QueryCache({
    onError: (err) => {
      // Login is required for everything: any 401 sends you to the login page.
      if (isUnauthorized(err) && !location.pathname.startsWith("/login") && !location.pathname.startsWith("/dev/")) {
        location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      }
    },
  }),
});

export const trpcClient = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: "/api/trpc", fetch: (url, init) => fetch(url, { ...init, credentials: "same-origin" }) })],
});

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [adminClient()],
});

export interface PublicConfig {
  providers: string[];
  devLogin: boolean;
}

export async function fetchPublicConfig(): Promise<PublicConfig> {
  const res = await fetch("/api/public-config");
  return res.json();
}

export function errorMessage(err: unknown): string {
  if (err instanceof TRPCClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}
