import { newId, user } from "@capturecat/db";
import { asc } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { auth } from "../auth.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { sendFetchResponse } from "./auth.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopback(request: FastifyRequest): boolean {
  return LOOPBACK.has(request.socket.remoteAddress ?? "");
}

/**
 * Development-only login. Registered only when DEV_LOGIN=1 and NODE_ENV != production
 * (index.ts refuses to start otherwise), and only answers loopback connections.
 */
export async function devRoutes(app: FastifyInstance): Promise<void> {
  if (!config.devLogin || config.isProduction) return;

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/dev/") && !isLoopback(request)) {
      return reply.code(404).send({ error: "Not found" });
    }
  });

  app.get("/api/dev/users", async () => {
    return db
      .select({ id: user.id, name: user.name, email: user.email, role: user.role, suspendedAt: user.suspendedAt })
      .from(user)
      .orderBy(asc(user.createdAt));
  });

  app.post("/api/dev/users", async () => {
    const id = newId(16);
    const n = Math.floor(Math.random() * 9000) + 1000;
    const [created] = await db
      .insert(user)
      .values({
        id,
        name: `User ${n}`,
        email: `user${n}@dev.capturecat.local`,
        emailVerified: true,
        quotaBytes: config.defaultQuotaBytes,
      })
      .returning({ id: user.id, name: user.name });
    return created;
  });

  app.post("/api/dev/login", async (request, reply) => {
    const body = z.object({ userId: z.string().min(1) }).parse(request.body);
    const url = new URL("/api/auth/dev/login", config.baseUrl);
    const response = await auth.handler(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", origin: config.origin },
        body: JSON.stringify(body),
      }),
    );
    return sendFetchResponse(reply, response);
  });
}
