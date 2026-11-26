import { auditLog, authTables, newId } from "@capturecat/db";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { admin } from "better-auth/plugins/admin";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { z } from "zod";
import { config } from "./config.js";
import { db } from "./db.js";

/**
 * Development-only sign-in: creates a real Better Auth session for an existing user.
 * Only registered when DEV_LOGIN=1 outside production; the Fastify route that exposes it
 * also restricts it to loopback requests (see routes/dev.ts).
 */
const devLoginPlugin = (): BetterAuthPlugin => ({
  id: "capturecat-dev-login",
  endpoints: {
    devLogin: createAuthEndpoint(
      "/dev/login",
      { method: "POST", body: z.object({ userId: z.string().min(1) }) },
      async (ctx) => {
        const found = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
        if (!found) throw new APIError("NOT_FOUND", { message: "No such user" });
        const session = await ctx.context.internalAdapter.createSession(found.id);
        if (!session) throw new APIError("INTERNAL_SERVER_ERROR", { message: "Could not create session" });
        await setSessionCookie(ctx, { session, user: found });
        return ctx.json({ userId: found.id });
      },
    ),
  },
});

const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
for (const [name, creds] of Object.entries(config.providers)) {
  if (creds) socialProviders[name] = creds;
}

export const auth = betterAuth({
  appName: "Capture Cat",
  baseURL: config.baseUrl,
  basePath: "/api/auth",
  secret: config.authSecret,
  trustedOrigins: [config.origin],
  database: drizzleAdapter(db, { provider: "pg", schema: authTables }),
  // OAuth only: no email/password sign-in, ever.
  emailAndPassword: { enabled: false },
  socialProviders,
  account: {
    accountLinking: { enabled: true, trustedProviders: ["google", "github"] },
  },
  user: {
    additionalFields: {
      quotaBytes: { type: "number", input: false, defaultValue: config.defaultQuotaBytes },
      usedBytes: { type: "number", input: false, defaultValue: 0 },
      suspendedAt: { type: "date", input: false, required: false },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  advanced: {
    database: { generateId: () => newId(16) },
    defaultCookieAttributes: { sameSite: "lax", httpOnly: true },
  },
  databaseHooks: {
    session: {
      create: {
        after: async (s) => {
          const impersonatedBy = (s as { impersonatedBy?: string | null }).impersonatedBy;
          if (impersonatedBy) {
            await db.insert(auditLog).values({
              id: newId(16),
              actorId: impersonatedBy,
              action: "impersonate.start",
              targetType: "user",
              targetId: s.userId,
              data: { sessionId: s.id, expiresAt: s.expiresAt },
            });
          }
        },
      },
    },
  },
  plugins: [
    admin({
      defaultRole: "user",
      adminRoles: ["admin"],
      impersonationSessionDuration: 60 * 30,
    }),
    ...(config.mockOidcDiscoveryUrl
      ? [
          genericOAuth({
            config: [
              {
                providerId: "mock",
                clientId: "capturecat",
                clientSecret: "capturecat",
                discoveryUrl: config.mockOidcDiscoveryUrl,
                scopes: ["openid", "email", "profile"],
              },
            ],
          }),
        ]
      : []),
    ...(config.devLogin ? [devLoginPlugin()] : []),
  ],
});

export const enabledProviders = [
  ...Object.keys(socialProviders),
  ...(config.mockOidcDiscoveryUrl ? ["mock"] : []),
];

