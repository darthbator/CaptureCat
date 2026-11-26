import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  annotation,
  createDb,
  EVENTS_CHANNEL,
  QUEUES,
  user,
  video,
  type FinalizeLiveJob,
  type ProcessUploadJob,
  type Video,
} from "@capturecat/db";
import type { ServerEvent } from "@capturecat/shared";
import { eq, sql as dsql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  canRemux,
  durationMs as probeDuration,
  MediaError,
  poster,
  probe,
  sprite,
  toHls,
  validateUpload,
  videoStream,
  type InputSpec,
} from "./ffmpeg.js";
import { cleanup } from "./cleanup.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://capturecat:capturecat@127.0.0.1:5433/capturecat";
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(repoRoot, ".dev", "data"));
const MEDIA_DIR = path.join(DATA_DIR, "media");
const RECORDINGS_DIR = path.join(DATA_DIR, "recordings");

const { db, sql } = createDb(DATABASE_URL, { max: 4 });
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), svc: "worker", msg, ...extra }));

async function emit(e: ServerEvent) {
  await sql.notify(EVENTS_CHANNEL, JSON.stringify(e));
}

const vis = (v: Video) => (v.visibility === "public" ? "public" : "private") as "public" | "private";

async function pathSize(p: string): Promise<number> {
  try {
    const s = await stat(p);
    if (!s.isDirectory()) return s.size;
    const sizes = await Promise.all((await readdir(p)).map((e) => pathSize(path.join(p, e))));
    return sizes.reduce((a, b) => a + b, 0);
  } catch {
    return 0;
  }
}

async function recomputeUsedBytes(userId: string) {
  await db
    .update(user)
    .set({ usedBytes: dsql`(select coalesce(sum(${video.sizeBytes}), 0) from ${video} where ${video.ownerId} = ${userId})` })
    .where(eq(user.id, userId));
}

function progressReporter(v: Video) {
  let last = 0;
  return (p: number) => {
    const now = Date.now();
    if (now - last < 1500) return;
    last = now;
    void db.update(video).set({ progress: p }).where(eq(video.id, v.id));
    void emit({ type: "video.progress", videoId: v.id, ownerId: v.ownerId, visibility: vis(v), progress: p });
  };
}

/** Serialize CPU-heavy packaging across both queues (no GPU on this server). */
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.then(fn, fn);
  lock = next.catch(() => {});
  return next;
}

/**
 * Shared packaging: HLS + poster + sprite into DATA_DIR/media/<id>/.
 * Returns duration and dimensions.
 */
async function packageVideo(v: Video, input: InputSpec, probeResult: Awaited<ReturnType<typeof probe>>) {
  const outDir = path.join(MEDIA_DIR, v.id);
  const hlsDir = path.join(outDir, "hls");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(hlsDir, { recursive: true });

  let duration = probeDuration(probeResult);
  const remux = canRemux(probeResult);
  log("packaging", { videoId: v.id, remux, durationMs: duration });
  await toHls(input, hlsDir, { remux, durationMs: duration, onProgress: progressReporter(v) });
  if (duration <= 0) duration = await playlistDurationMs(path.join(hlsDir, "index.m3u8"));

  await poster(input, path.join(outDir, "poster.jpg"), Math.min(1000, duration / 10));
  let hasThumbnails = false;
  if (duration > 0) {
    try {
      const vtt = await sprite(input, outDir, duration);
      await writeFile(path.join(outDir, "thumbs.vtt"), vtt);
      hasThumbnails = true;
    } catch (err) {
      log("sprite failed (non-fatal)", { videoId: v.id, err: String(err) });
    }
  }
  const vs = videoStream(probeResult);
  return { durationMs: duration, width: vs.width ?? null, height: vs.height ?? null, hasThumbnails, outDir };
}

/** Sum of #EXTINF durations in a VOD playlist (fallback when probing gives none). */
async function playlistDurationMs(file: string): Promise<number> {
  const text = await readFile(file, "utf8").catch(() => "");
  let total = 0;
  for (const m of text.matchAll(/#EXTINF:([\d.]+)/g)) total += Number(m[1]);
  return Math.round(total * 1000);
}

async function markFailed(v: Video, message: string) {
  await db.update(video).set({ status: "failed", error: message.slice(0, 500), progress: null, updatedAt: new Date() }).where(eq(video.id, v.id));
  await emit({ type: "video.updated", videoId: v.id, ownerId: v.ownerId, visibility: vis(v) });
}

async function markReady(v: Video, result: Awaited<ReturnType<typeof packageVideo>>, extra: Partial<Video> = {}) {
  const sizeBytes = await pathSize(result.outDir);
  await db
    .update(video)
    .set({
      status: "ready",
      durationMs: result.durationMs,
      width: result.width,
      height: result.height,
      hasThumbnails: result.hasThumbnails,
      sizeBytes,
      sourcePath: null,
      progress: 1,
      error: null,
      updatedAt: new Date(),
      ...extra,
    })
    .where(eq(video.id, v.id));
  await recomputeUsedBytes(v.ownerId);
  await emit({ type: "video.updated", videoId: v.id, ownerId: v.ownerId, visibility: vis(v) });
}

async function processUpload(job: ProcessUploadJob) {
  const [v] = await db.select().from(video).where(eq(video.id, job.videoId));
  if (!v) return log("video gone", job as unknown as Record<string, unknown>);
  if (!v.sourcePath) return markFailed(v, "The uploaded file is missing.");
  try {
    const raw = await probe(v.sourcePath).catch(() => {
      throw new MediaError("This file couldn't be read as a video.");
    });
    const demuxer = validateUpload(raw);
    const input: InputSpec = { path: v.sourcePath, demuxer };
    const result = await exclusive(() => packageVideo(v, input, raw));
    // Originals are deleted after successful processing.
    await rm(v.sourcePath, { force: true });
    await rm(`${v.sourcePath}.json`, { force: true });
    await markReady(v, result);
    log("upload ready", { videoId: v.id });
  } catch (err) {
    log("upload failed", { videoId: v.id, err: String(err) });
    await markFailed(v, err instanceof MediaError ? err.message : "Processing failed. You can retry.");
  }
}

/** Recording files are named <unix seconds>-<microseconds>.mp4 (MediaMTX recordPath %s-%f). */
function recordingStartMs(file: string): number | null {
  const m = /^(\d+)-(\d+)\.mp4$/.exec(file);
  return m ? Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1000) : null;
}

async function finalizeLive(job: FinalizeLiveJob) {
  const [v] = await db.select().from(video).where(eq(video.id, job.videoId));
  if (!v || !v.channelId || !v.startedAt) return;
  const dir = path.join(RECORDINGS_DIR, "live", v.channelId);
  const endedMs = (v.endedAt ?? new Date()).getTime();
  const files = (await readdir(dir).catch(() => [] as string[]))
    .map((f) => ({ f, at: recordingStartMs(f) }))
    .filter((x): x is { f: string; at: number } => x.at !== null)
    .filter((x) => x.at >= v.startedAt!.getTime() - 60_000 && x.at <= endedMs + 5_000)
    .sort((a, b) => a.at - b.at);
  if (files.length === 0) return markFailed(v, "No recording was found for this stream.");

  try {
    const workDir = path.join(DATA_DIR, "tmp", v.id);
    await mkdir(workDir, { recursive: true });
    const listFile = path.join(workDir, "concat.txt");
    // Trusted list we generate ourselves; paths are quoted for the concat demuxer.
    await writeFile(
      listFile,
      files.map(({ f }) => `file '${path.join(dir, f).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"),
    );
    const input: InputSpec = { path: listFile, concat: true };
    const probed = await probe(listFile, { concat: true });
    // The concat demuxer doesn't report a total duration; sum the segments instead.
    let totalS = 0;
    for (const { f } of files) {
      const seg = await probe(path.join(dir, f), { demuxer: "mov" });
      totalS += Number(seg.format.duration) || 0;
    }
    probed.format.duration = String(totalS);
    const result = await exclusive(() => packageVideo(v, input, probed));

    // Align annotation times with the recording: offsets were relative to startedAt
    // (stream ready time); the VOD starts at the first recorded frame.
    const recStart = files[0]!.at;
    const shift = v.startedAt.getTime() - recStart;
    if (Math.abs(shift) > 50) {
      await db
        .update(annotation)
        .set({
          startMs: dsql`greatest(0, ${annotation.startMs} + ${shift})`,
          endMs: dsql`greatest(${annotation.endMs} + ${shift}, 500)`,
        })
        .where(eq(annotation.videoId, v.id));
      log("shifted live annotations", { videoId: v.id, shiftMs: shift });
    }

    for (const { f } of files) await rm(path.join(dir, f), { force: true });
    await rm(workDir, { recursive: true, force: true });
    await markReady(v, result, { startedAt: new Date(recStart) });
    log("live recording ready", { videoId: v.id, segments: files.length });
  } catch (err) {
    log("finalize failed", { videoId: v.id, err: String(err) });
    await markFailed(v, "Couldn't finalize the recording.");
    throw err; // let pg-boss retry
  }
}

const boss = new PgBoss({ connectionString: DATABASE_URL, schema: "pgboss" });
boss.on("error", (err) => log("pg-boss error", { err: String(err) }));
await boss.start();
for (const q of Object.values(QUEUES)) await boss.createQueue(q);

// One job at a time: no GPU, so transcoding is CPU-bound.
await boss.work<ProcessUploadJob>(QUEUES.processUpload, { batchSize: 1, pollingIntervalSeconds: 1 }, async ([job]) => {
  if (job) await processUpload(job.data);
});
await boss.work<FinalizeLiveJob>(QUEUES.finalizeLive, { batchSize: 1, pollingIntervalSeconds: 1 }, async ([job]) => {
  if (job) await finalizeLive(job.data);
});

const runCleanup = () => cleanup(db, DATA_DIR, log).catch((err) => log("cleanup failed", { err: String(err) }));
void runCleanup();
const cleanupTimer = setInterval(runCleanup, 3600_000);

log("worker ready", { dataDir: DATA_DIR });

const shutdown = async () => {
  clearInterval(cleanupTimer);
  await boss.stop();
  await sql.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
