import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_QUOTA_BYTES, GiB } from "@capturecat/shared";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

const env = z
  .object({
    NODE_ENV: z.string().default("development"),
    PORT: z.coerce.number().default(4000),
    HOST: z.string().default("127.0.0.1"),
    /** Public origin users see (Vite dev server in development, the domain in production). */
    BASE_URL: z.string().url().default("http://localhost:5173"),
    DATABASE_URL: z.string().default("postgres://capturecat:capturecat@127.0.0.1:5433/capturecat"),
    BETTER_AUTH_SECRET: z.string().min(16).default("dev-only-secret-change-me-in-production"),
    DATA_DIR: z.string().default(path.join(repoRoot, ".dev", "data")),
    DEV_LOGIN: bool,
    DEFAULT_QUOTA_GB: z.coerce.number().positive().optional(),
    MIN_FREE_DISK_GB: z.coerce.number().min(0).default(5),
    /** MediaMTX control API and HLS server (internal network only). */
    MEDIAMTX_API_URL: z.string().default("http://127.0.0.1:9997"),
    MEDIAMTX_HLS_URL: z.string().default("http://127.0.0.1:8888"),
    /** Shared secret: MediaMTX → API hook URL, and API → MediaMTX basic auth. */
    MEDIAMTX_SECRET: z.string().min(8).default("dev-mediamtx-secret"),
    /** Public ingest host shown to streamers (defaults to BASE_URL's hostname). */
    INGEST_HOST: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    TWITCH_CLIENT_ID: z.string().optional(),
    TWITCH_CLIENT_SECRET: z.string().optional(),
    DISCORD_CLIENT_ID: z.string().optional(),
    DISCORD_CLIENT_SECRET: z.string().optional(),
    /** Mock OIDC provider for testing the real OAuth flow (dev compose only). */
    MOCK_OIDC_DISCOVERY_URL: z.string().optional(),
  })
  .parse(process.env);

export const config = {
  isProduction: env.NODE_ENV === "production",
  port: env.PORT,
  host: env.HOST,
  baseUrl: env.BASE_URL.replace(/\/$/, ""),
  origin: new URL(env.BASE_URL).origin,
  databaseUrl: env.DATABASE_URL,
  authSecret: env.BETTER_AUTH_SECRET,
  dataDir: path.resolve(env.DATA_DIR),
  devLogin: env.DEV_LOGIN,
  defaultQuotaBytes: env.DEFAULT_QUOTA_GB ? Math.round(env.DEFAULT_QUOTA_GB * GiB) : DEFAULT_QUOTA_BYTES,
  minFreeDiskBytes: Math.round(env.MIN_FREE_DISK_GB * GiB),
  mediamtx: {
    apiUrl: env.MEDIAMTX_API_URL.replace(/\/$/, ""),
    hlsUrl: env.MEDIAMTX_HLS_URL.replace(/\/$/, ""),
    secret: env.MEDIAMTX_SECRET,
  },
  ingestHost: env.INGEST_HOST ?? new URL(env.BASE_URL).hostname,
  providers: {
    google: pair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    github: pair(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
    twitch: pair(env.TWITCH_CLIENT_ID, env.TWITCH_CLIENT_SECRET),
    discord: pair(env.DISCORD_CLIENT_ID, env.DISCORD_CLIENT_SECRET),
  },
  mockOidcDiscoveryUrl: env.MOCK_OIDC_DISCOVERY_URL,
};

function pair(clientId?: string, clientSecret?: string) {
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Fail fast on dangerous production configuration. */
export function assertSafeConfig(): void {
  if (config.isProduction && config.devLogin) {
    throw new Error("Refusing to start: DEV_LOGIN=1 is not allowed when NODE_ENV=production.");
  }
  if (config.isProduction && config.authSecret.startsWith("dev-only")) {
    throw new Error("Refusing to start: set BETTER_AUTH_SECRET in production.");
  }
  if (config.isProduction && config.mediamtx.secret.startsWith("dev-")) {
    throw new Error("Refusing to start: set MEDIAMTX_SECRET in production.");
  }
}

export const paths = {
  uploads: path.join(config.dataDir, "uploads"),
  media: path.join(config.dataDir, "media"),
  recordings: path.join(config.dataDir, "recordings"),
};
