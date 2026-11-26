import { mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { user, video } from "@capturecat/db";
import { checkStorage, type StorageCheck } from "@capturecat/shared";
import { eq, sql as dsql } from "drizzle-orm";
import { config, paths } from "./config.js";
import { db } from "./db.js";

export async function ensureDataDirs(): Promise<void> {
  await Promise.all(Object.values(paths).map((p) => mkdir(p, { recursive: true })));
}

export async function freeDiskBytes(): Promise<number> {
  const s = await statfs(config.dataDir);
  return Number(s.bavail) * Number(s.bsize);
}

/** Recursive size of a file or directory; 0 if missing. */
export async function pathSize(p: string): Promise<number> {
  try {
    const s = await stat(p);
    if (!s.isDirectory()) return s.size;
    const entries = await readdir(p);
    const sizes = await Promise.all(entries.map((e) => pathSize(path.join(p, e))));
    return sizes.reduce((a, b) => a + b, 0);
  } catch {
    return 0;
  }
}

/** used_bytes = sum of the user's videos' size_bytes. */
export async function recomputeUsedBytes(userId: string): Promise<number> {
  const [row] = await db
    .select({ total: dsql<string>`coalesce(sum(${video.sizeBytes}), 0)` })
    .from(video)
    .where(eq(video.ownerId, userId));
  const total = Number(row?.total ?? 0);
  await db.update(user).set({ usedBytes: total }).where(eq(user.id, userId));
  return total;
}

export async function checkUserStorage(userId: string, incomingBytes: number): Promise<StorageCheck> {
  const [u] = await db.select().from(user).where(eq(user.id, userId));
  if (!u) return { ok: false, reason: "quota", message: "Unknown user" };
  return checkStorage({
    quotaBytes: u.quotaBytes,
    usedBytes: u.usedBytes,
    incomingBytes,
    freeDiskBytes: await freeDiskBytes(),
    minFreeDiskBytes: config.minFreeDiskBytes,
  });
}

/** Bytes recorded so far for a channel's in-progress live stream. */
export async function recordingBytes(channelId: string): Promise<number> {
  return pathSize(path.join(paths.recordings, "live", channelId));
}

export async function deleteVideoFiles(videoId: string, sourcePath: string | null): Promise<void> {
  await rm(path.join(paths.media, videoId), { recursive: true, force: true });
  if (sourcePath) {
    await rm(sourcePath, { force: true });
    await rm(`${sourcePath}.json`, { force: true });
  }
}
