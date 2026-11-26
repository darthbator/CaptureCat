import { createHash, randomBytes } from "node:crypto";
import { channel, newId, video } from "@capturecat/db";
import { quotaState, VISIBILITIES } from "@capturecat/shared";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../db.js";
import { recordingBytes } from "../storage.js";
import { authed, router } from "./trpc.js";

export function hashStreamKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export async function getOrCreateChannel(userId: string) {
  const [existing] = await db.select().from(channel).where(eq(channel.userId, userId));
  if (existing) return existing;
  const [created] = await db
    .insert(channel)
    .values({ id: newId(10), userId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [again] = await db.select().from(channel).where(eq(channel.userId, userId));
  return again!;
}

export const channelRouter = router({
  get: authed.query(async ({ ctx }) => {
    const ch = await getOrCreateChannel(ctx.user.id);
    const [live] = await db
      .select()
      .from(video)
      .where(and(eq(video.channelId, ch.id), eq(video.status, "live")));
    const recBytes = live ? await recordingBytes(ch.id) : 0;
    const used = ctx.user.usedBytes + recBytes;
    return {
      channelId: ch.id,
      hasKey: !!ch.streamKeyHash,
      liveVisibility: ch.liveVisibility as "private" | "public",
      liveTitle: ch.liveTitle ?? "",
      ingest: {
        rtmpServer: `rtmp://${config.ingestHost}:1935/live`,
        streamKeyFormat: `${ch.id}?key=<your stream key>`,
        srtUrl: `srt://${config.ingestHost}:8890?streamid=publish:live/${ch.id}:capturecat:<your stream key>`,
      },
      live: live ? { videoId: live.id, startedAt: live.startedAt?.toISOString() ?? null } : null,
      storage: {
        quotaBytes: ctx.user.quotaBytes,
        usedBytes: used,
        state: quotaState(ctx.user.quotaBytes, used),
      },
      suspended: ctx.user.suspended,
    };
  }),

  /** Generate a new stream key. Returned once; only its hash is stored. */
  regenerateKey: authed.mutation(async ({ ctx }) => {
    const ch = await getOrCreateChannel(ctx.user.id);
    const key = randomBytes(18).toString("base64url");
    await db.update(channel).set({ streamKeyHash: hashStreamKey(key) }).where(eq(channel.id, ch.id));
    return { key, obsStreamKey: `${ch.id}?key=${key}` };
  }),

  update: authed
    .input(z.object({ liveVisibility: z.enum(VISIBILITIES).optional(), liveTitle: z.string().trim().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const ch = await getOrCreateChannel(ctx.user.id);
      await db
        .update(channel)
        .set({
          ...(input.liveVisibility ? { liveVisibility: input.liveVisibility } : {}),
          ...(input.liveTitle !== undefined ? { liveTitle: input.liveTitle || null } : {}),
        })
        .where(eq(channel.id, ch.id));
      return { ok: true };
    }),
});
