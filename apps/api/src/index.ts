import { runMigrations } from "@capturecat/db";
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from "@trpc/server/adapters/fastify";
import Fastify from "fastify";
import { assertSafeConfig, config } from "./config.js";
import { startEventListener } from "./events.js";
import { startLiveMonitor } from "./live/monitor.js";
import { startQueue } from "./queue.js";
import { authRoutes } from "./routes/auth.js";
import { devRoutes } from "./routes/dev.js";
import { mediamtxRoutes } from "./routes/mediamtx.js";
import { mediaRoutes } from "./routes/media.js";
import { sseRoutes } from "./routes/sse.js";
import { uploadRoutes } from "./routes/uploads.js";
import { ensureDataDirs } from "./storage.js";
import { appRouter, type AppRouter } from "./trpc/router.js";
import { createContext } from "./trpc/trpc.js";

assertSafeConfig();
await ensureDataDirs();
await runMigrations(config.databaseUrl);
await startQueue();
await startEventListener();

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  routerOptions: { maxParamLength: 5000 },
  trustProxy: config.isProduction,
  bodyLimit: 1024 * 1024,
  disableRequestLogging: true,
});

// Compact request log, skipping high-volume internal traffic (MediaMTX hooks, media segments).
const QUIET = ["/api/mediamtx/", "/media/", "/live/", "/api/health"];
app.addHook("onResponse", async (request, reply) => {
  if (QUIET.some((p) => request.url.startsWith(p)) && reply.statusCode < 500) return;
  app.log.info(`${request.method} ${request.url.split("?")[0]} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms`);
});

/**
 * CSRF defence for cookie-authenticated mutations: the Origin header must match our
 * public origin. Better Auth checks its own routes; MediaMTX hooks use a shared secret.
 */
app.addHook("onRequest", async (request, reply) => {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
  if (request.url.startsWith("/api/auth/") || request.url.startsWith("/api/mediamtx/")) return;
  if (request.url.startsWith("/api/dev/")) return; // loopback-only, dev-only
  const origin = request.headers.origin;
  if (origin !== config.origin) {
    return reply.code(403).send({ error: "Bad origin" });
  }
});

await app.register(authRoutes);
await app.register(devRoutes);
await app.register(mediamtxRoutes);
await app.register(mediaRoutes);
await app.register(sseRoutes);
await app.register(uploadRoutes);
await app.register(fastifyTRPCPlugin, {
  prefix: "/api/trpc",
  trpcOptions: {
    router: appRouter,
    createContext,
    onError({ path, error }) {
      if (error.code === "INTERNAL_SERVER_ERROR") app.log.error({ path, err: error }, "tRPC error");
    },
  } satisfies FastifyTRPCPluginOptions<AppRouter>["trpcOptions"],
});

app.get("/api/health", async () => ({ ok: true }));

const stopMonitor = startLiveMonitor(app.log);

const shutdown = async () => {
  stopMonitor();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.port, host: config.host });
if (config.devLogin) app.log.warn("DEV LOGIN ENABLED: /dev/login can sign in as any user (development only)");
