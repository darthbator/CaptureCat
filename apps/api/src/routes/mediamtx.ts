import { timingSafeEqual } from "node:crypto";
import { channel, user } from "@capturecat/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../db.js";
import { checkUserStorage } from "../storage.js";
import { hashStreamKey } from "../trpc/channel.js";

const hookBody = z.object({
  user: z.string().optional().default(""),
  password: z.string().optional().default(""),
  token: z.string().optional().default(""),
  ip: z.string().optional().default(""),
  action: z.string(),
  path: z.string().optional().default(""),
  protocol: z.string().optional().default(""),
  id: z.string().nullable().optional(),
  query: z.string().optional().default(""),
});

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Validate a publish attempt: `live/<channelId>` with the channel's stream key. */
export async function authorizePublish(path: string, query: string, password: string): Promise<{ ok: boolean; reason: string }> {
  const m = /^live\/([A-Za-z0-9]+)$/.exec(path);
  if (!m) return { ok: false, reason: "bad path" };
  const key = new URLSearchParams(query).get("key") || password;
  if (!key) return { ok: false, reason: "missing key" };
  const [ch] = await db.select().from(channel).where(eq(channel.id, m[1]!));
  if (!ch?.streamKeyHash || !safeEqual(ch.streamKeyHash, hashStreamKey(key))) return { ok: false, reason: "bad key" };
  const [u] = await db.select().from(user).where(eq(user.id, ch.userId));
  if (!u || u.suspendedAt) return { ok: false, reason: "suspended" };
  const storage = await checkUserStorage(u.id, 1);
  if (!storage.ok) return { ok: false, reason: storage.message };
  return { ok: true, reason: "ok" };
}

/**
 * MediaMTX HTTP auth hook (authMethod: http). MediaMTX calls this for every action.
 * - publish: stream key check (OBS key `<channelId>?key=<secret>`).
 * - read/playback/api/metrics: only our API, using internal basic-auth credentials.
 * The hook URL carries ?secret=MEDIAMTX_SECRET so nothing else can call it.
 */
export async function mediamtxRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Querystring: { secret?: string } }>("/api/mediamtx/auth", async (request, reply) => {
    if (!safeEqual(request.query.secret ?? "", config.mediamtx.secret)) return reply.code(401).send();
    const parsed = hookBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send();
    const b = parsed.data;

    if (b.action === "publish") {
      const result = await authorizePublish(b.path, b.query, b.password);
      if (!result.ok) request.log.warn({ path: b.path, ip: b.ip, reason: result.reason }, "publish rejected");
      return reply.code(result.ok ? 200 : 401).send();
    }

    const internal = b.user === "capturecat" && safeEqual(b.password, config.mediamtx.secret);
    return reply.code(internal ? 200 : 401).send();
  });
}
