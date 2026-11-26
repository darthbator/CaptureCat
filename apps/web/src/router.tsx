import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { AppShell } from "./components/AppShell";
import { AdminPage } from "./pages/Admin";
import { BrowsePage } from "./pages/Browse";
import { DevLoginPage } from "./pages/DevLogin";
import { FeedPage } from "./pages/Feed";
import { LibraryPage } from "./pages/Library";
import { LoginPage } from "./pages/Login";
import { StudioPage } from "./pages/Studio";
import { lazy, Suspense } from "react";
import { Spinner } from "./components/ui";

// The watch page pulls in hls.js; load it on demand.
const WatchPage = lazy(() => import("./pages/Watch").then((m) => ({ default: m.WatchPage })));

const rootRoute = createRootRoute({ component: () => <Outlet /> });

// Public (no session needed): login and the dev login page.
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (s: Record<string, unknown>): { next?: string } => (typeof s.next === "string" ? { next: s.next } : {}),
  component: LoginPage,
});
const devLoginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/dev/login", component: DevLoginPage });

// Everything else is behind login (AppShell redirects on 401).
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: "app", component: AppShell });
const feedRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: FeedPage });
const browseRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/browse",
  validateSearch: (s: Record<string, unknown>): { q?: string } => (typeof s.q === "string" && s.q ? { q: s.q } : {}),
  component: BrowsePage,
});
const libraryRoute = createRoute({ getParentRoute: () => appRoute, path: "/library", component: LibraryPage });
const studioRoute = createRoute({ getParentRoute: () => appRoute, path: "/studio", component: StudioPage });
const adminRoute = createRoute({ getParentRoute: () => appRoute, path: "/admin", component: AdminPage });
const watchRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/v/$videoId",
  component: () => (
    <Suspense fallback={<Spinner />}>
      <WatchPage />
    </Suspense>
  ),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  devLoginRoute,
  appRoute.addChildren([feedRoute, browseRoute, libraryRoute, studioRoute, adminRoute, watchRoute]),
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
