import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { video, type Db } from "@capturecat/db";
import { eq, isNotNull } from "drizzle-orm";

const HOUR = 3600_000;

/**
 * Disk housekeeping (runs hourly in the worker):
 * - abandoned partial uploads (tus files no video references) older than 48 h
 * - raw live recordings older than 7 days that no live/processing video still needs
 *   (e.g. a stream whose finalize failed permanently)
 * - leftover job temp folders older than 24 h
 */
export async function cleanup(db: Db, dataDir: string, log: (msg: string, extra?: Record<string, unknown>) => void) {
  const now = Date.now();
  let removed = 0;

  const referenced = new Set(
    (await db.select({ p: video.sourcePath }).from(video).where(isNotNull(video.sourcePath))).map((r) => path.resolve(r.p!)),
  );
  const uploads = path.join(dataDir, "uploads");
  for (const f of await readdir(uploads).catch(() => [] as string[])) {
    const full = path.resolve(uploads, f);
    const base = full.endsWith(".json") ? full.slice(0, -5) : full;
    if (referenced.has(base)) continue;
    const s = await stat(full).catch(() => null);
    if (s && now - s.mtimeMs > 48 * HOUR) {
      await rm(full, { force: true });
      removed++;
    }
  }

  const busyChannels = new Set(
    (await db.select({ c: video.channelId }).from(video).where(eq(video.status, "live")))
      .concat(await db.select({ c: video.channelId }).from(video).where(eq(video.status, "processing")))
      .map((r) => r.c),
  );
  const liveDir = path.join(dataDir, "recordings", "live");
  for (const channelId of await readdir(liveDir).catch(() => [] as string[])) {
    if (busyChannels.has(channelId)) continue;
    const dir = path.join(liveDir, channelId);
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      const s = await stat(path.join(dir, f)).catch(() => null);
      if (s && now - s.mtimeMs > 7 * 24 * HOUR) {
        await rm(path.join(dir, f), { force: true });
        removed++;
      }
    }
  }

  const tmp = path.join(dataDir, "tmp");
  for (const d of await readdir(tmp).catch(() => [] as string[])) {
    const s = await stat(path.join(tmp, d)).catch(() => null);
    if (s && now - s.mtimeMs > 24 * HOUR) {
      await rm(path.join(tmp, d), { recursive: true, force: true });
      removed++;
    }
  }

  if (removed) log("cleanup removed stale files", { removed });
}
