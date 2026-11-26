import { channel, newId, user, video } from "@capturecat/db";
import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import { db } from "../db.js";
import { publish } from "../events.js";
import { enqueueFinalizeLive } from "../queue.js";
import { mediamtxAuthHeader } from "../routes/media.js";
import { recordingBytes } from "../storage.js";
import { invalidateVideo } from "../viewer.js";

interface MtxPath {
  name: string;
  ready: boolean;
  readyTime: string | null;
  source: { type: string; id: string } | null;
}

const KICK_ENDPOINT: Record<string, string> = {
  rtmpConn: "rtmpconns",
  rtmpsConn: "rtmpconns",
  srtConn: "srtconns",
  webRTCSession: "webrtcsessions",
  rtspSession: "rtspsessions",
  rtspsSession: "rtspsessions",
};

async function mtx<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.mediamtx.apiUrl}${path}`, {
    ...init,
    headers: { authorization: mediamtxAuthHeader(), ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`MediaMTX ${path} → ${res.status}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export async function kickPublisher(source: MtxPath["source"]): Promise<void> {
  if (!source) return;
  const endpoint = KICK_ENDPOINT[source.type];
  if (!endpoint) return;
  await mtx(`/v3/${endpoint}/kick/${source.id}`, { method: "POST" });
}

/** Missed polls before a live video is considered ended (protects against brief blips). */
const END_AFTER_MISSES = 2;

/**
 * Polls MediaMTX's control API to detect streams starting and stopping, creates/ends
 * live Video rows, and enforces storage quotas during a broadcast.
 * Polling (rather than runOnReady shell hooks) keeps this portable across Windows/Linux.
 */
export function startLiveMonitor(log: FastifyBaseLogger, intervalMs = 2000): () => void {
  const misses = new Map<string, number>();
  let running = false;
  let mtxDown = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      let items: MtxPath[];
      try {
        items = (await mtx<{ items: MtxPath[] }>("/v3/paths/list?itemsPerPage=1000")).items ?? [];
        if (mtxDown) log.info("MediaMTX reachable again");
        mtxDown = false;
      } catch (err) {
        if (!mtxDown) log.warn({ err: String(err) }, "MediaMTX API unreachable; live monitoring paused");
        mtxDown = true;
        return;
      }

      const ready = new Map<string, MtxPath>();
      for (const p of items) {
        const m = /^live\/([A-Za-z0-9]+)$/.exec(p.name);
        if (m && p.ready) ready.set(m[1]!, p);
      }

      const liveRows = await db.select().from(video).where(eq(video.status, "live"));
      const liveByChannel = new Map(liveRows.map((v) => [v.channelId!, v]));

      // New streams.
      for (const [channelId, p] of ready) {
        if (liveByChannel.has(channelId)) continue;
        const [ch] = await db.select().from(channel).where(eq(channel.id, channelId));
        if (!ch) continue;
        const startedAt = p.readyTime ? new Date(p.readyTime) : new Date();
        const isPublic = ch.liveVisibility === "public";
        const [created] = await db
          .insert(video)
          .values({
            id: newId(),
            ownerId: ch.userId,
            channelId,
            title: ch.liveTitle || `Live stream ${startedAt.toISOString().slice(0, 16).replace("T", " ")}`,
            source: "live",
            status: "live",
            visibility: isPublic ? "public" : "private",
            publishedAt: isPublic ? startedAt : null,
            startedAt,
          })
          .returning();
        log.info({ videoId: created!.id, channelId }, "stream started");
        await publish({ type: "video.updated", videoId: created!.id, ownerId: ch.userId, visibility: created!.visibility as "private" | "public" });
      }

      // Ended streams and quota enforcement.
      for (const v of liveRows) {
        const p = ready.get(v.channelId!);
        if (!p) {
          const n = (misses.get(v.id) ?? 0) + 1;
          misses.set(v.id, n);
          if (n < END_AFTER_MISSES) continue;
          misses.delete(v.id);
          await db
            .update(video)
            .set({ status: "processing", endedAt: new Date(), progress: 0, updatedAt: new Date() })
            .where(and(eq(video.id, v.id), eq(video.status, "live")));
          invalidateVideo(v.id);
          await enqueueFinalizeLive({ videoId: v.id });
          log.info({ videoId: v.id }, "stream ended; finalizing");
          await publish({ type: "video.updated", videoId: v.id, ownerId: v.ownerId, visibility: v.visibility as "private" | "public" });
          continue;
        }
        misses.delete(v.id);
        const [u] = await db.select().from(user).where(eq(user.id, v.ownerId));
        if (!u) continue;
        const used = u.usedBytes + (await recordingBytes(v.channelId!));
        if (used >= u.quotaBytes) {
          log.warn({ videoId: v.id }, "storage quota reached during stream; disconnecting");
          await kickPublisher(p.source).catch((err) => log.error({ err: String(err) }, "kick failed"));
        }
      }
    } catch (err) {
      log.error({ err }, "live monitor tick failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  void tick();
  return () => clearInterval(timer);
}
