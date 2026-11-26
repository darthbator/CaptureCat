/**
 * End-to-end smoke test against a running dev stack (`pnpm dev`, seeded).
 * Exercises: login wall, dev login, tus upload → HLS, private/public permissions,
 * annotations + SSE, quota refusal, malicious upload rejection, CPU transcode path,
 * live streaming via RTMP (wrong key rejected, live HLS with PROGRAM-DATE-TIME,
 * live annotation → finalized recording), suspension, delete + quota accounting.
 *
 *   pnpm test:smoke            (SMOKE_BASE_URL defaults to http://localhost:5173)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import * as tus from "tus-js-client";

const BASE = (process.env.SMOKE_BASE_URL ?? "http://localhost:5173").replace(/\/$/, "");
const ORIGIN = new URL(BASE).origin;
const RTMP = process.env.SMOKE_RTMP_URL ?? "rtmp://127.0.0.1:1935/live";
const FFMPEG = ffmpegPath as unknown as string;
const tmp = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".dev", "smoke");

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------- HTTP helpers ----------------------------- */

class Client {
  cookie = "";
  constructor(public label: string) {}

  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${BASE}${url}`, {
      method,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        origin: ORIGIN,
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    const setCookies = res.headers.getSetCookie();
    if (setCookies.length) {
      const jar = new Map(this.cookie.split("; ").filter(Boolean).map((c) => [c.split("=")[0]!, c]));
      for (const c of setCookies) {
        const pair = c.split(";")[0]!;
        jar.set(pair.split("=")[0]!, pair);
      }
      this.cookie = [...jar.values()].join("; ");
    }
    return res;
  }

  async login(userId: string) {
    const res = await this.req("POST", "/api/dev/login", { userId });
    if (!res.ok) throw new Error(`login ${userId} failed: ${res.status}`);
    return this;
  }

  async query<T = any>(proc: string, input?: unknown): Promise<{ status: number; data?: T; error?: any }> {
    const qs = input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : "";
    const res = await this.req("GET", `/api/trpc/${proc}${qs}`);
    const json = (await res.json().catch(() => ({}))) as any;
    return { status: res.status, data: json?.result?.data, error: json?.error };
  }

  async mutate<T = any>(proc: string, input?: unknown): Promise<{ status: number; data?: T; error?: any }> {
    const res = await this.req("POST", `/api/trpc/${proc}`, input ?? {});
    const json = (await res.json().catch(() => ({}))) as any;
    return { status: res.status, data: json?.result?.data, error: json?.error };
  }

  upload(file: string, filename: string): Promise<{ ok: boolean; videoId?: string; status?: number; message?: string }> {
    return readFile(file).then(
      (buf) =>
        new Promise((resolve) => {
          let videoId: string | undefined;
          const up = new tus.Upload(buf, {
            endpoint: `${BASE}/api/uploads`,
            headers: { cookie: this.cookie, origin: ORIGIN },
            metadata: { filename },
            chunkSize: 1024 * 1024,
            retryDelays: [],
            onAfterResponse: (_req, res) => {
              const id = res.getHeader("x-video-id");
              if (id) videoId = id;
            },
            onSuccess: () => resolve({ ok: true, videoId }),
            onError: (err: any) =>
              resolve({ ok: false, status: err?.originalResponse?.getStatus?.(), message: err?.originalResponse?.getBody?.() }),
          });
          up.start();
        }),
    );
  }

  /** Collect SSE events for a URL in the background. */
  sse(url: string) {
    const events: any[] = [];
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${BASE}${url}`, { headers: { cookie: this.cookie }, signal: controller.signal });
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = chunk.split("\n").find((l) => l.startsWith("data: "));
            if (data) events.push(JSON.parse(data.slice(6)));
          }
        }
      } catch {
        /* aborted */
      }
    })();
    return { events, close: () => controller.abort() };
  }
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 120_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function waitReady(c: Client, videoId: string) {
  return waitFor(`video ${videoId} ready/failed`, async () => {
    const r = await c.query("videos.get", { id: videoId });
    return r.data && (r.data.status === "ready" || r.data.status === "failed") ? r.data : null;
  });
}

function ffmpeg(args: string[]): ChildProcess {
  return spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", ...args], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
}
function runFfmpeg(args: string[]): Promise<number> {
  return new Promise((resolve) => ffmpeg(args).on("close", (code) => resolve(code ?? 1)));
}

/* --------------------------------- test --------------------------------- */

await mkdir(tmp, { recursive: true });
const mp4 = path.join(tmp, "sample.mp4");
const avi = path.join(tmp, "sample.avi");
const evil = path.join(tmp, "evil.m3u8");
console.log("Generating sample media…");
await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "60", "-c:a", "aac", "-shortest", mp4]);
await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-t", "4", "-c:v", "mpeg4", avi]);
await writeFile(evil, "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n");

const anon = new Client("anon");
const alice = await new Client("alice").login("dev-alice");
const bob = await new Client("bob").login("dev-bob");
const admin = await new Client("admin").login("dev-admin");
const full = await new Client("quota-full").login("dev-quota-full");

console.log("Login wall");
check("signed-out tRPC → 401", (await anon.query("me")).status === 401);
check("signed-out media → 401", (await anon.req("GET", "/media/x/hls/index.m3u8")).status === 401);
check("signed-out live → 401", (await anon.req("GET", "/live/x/index.m3u8")).status === 401);
check("signed-out SSE → 401", (await anon.req("GET", "/api/events")).status === 401);
check("Better Auth's internal dev route not exposed", (await anon.req("POST", "/api/auth/dev/login", { userId: "dev-admin" })).status === 404);
check("bad Origin on mutation → 403", (await alice.req("POST", "/api/trpc/channel.update", {}, { origin: "http://evil.example" })).status === 403);
check("dev login works", (await alice.query("me")).data?.id === "dev-alice");

console.log("Upload (remux path)");
const before = (await alice.query("me")).data.usedBytes as number;
const up = await alice.upload(mp4, "My Sample Clip.mp4");
check("tus upload succeeded", up.ok && !!up.videoId, up);
const vid = up.videoId!;
const ready = await waitReady(alice, vid);
check("video processed to ready", ready.status === "ready", ready.error);
check("title from filename", ready.title === "My Sample Clip");
check("duration ≈ 8 s", Math.abs((ready.durationMs ?? 0) - 8000) < 600, ready.durationMs);
check("HLS playlist served to owner", (await alice.req("GET", ready.urls.hls)).status === 200);
check("poster served", (await alice.req("GET", ready.urls.poster)).status === 200);
check("thumbnail VTT served", ready.urls.thumbnails && (await alice.req("GET", ready.urls.thumbnails)).status === 200);
check("path traversal rejected", [400, 404].includes((await alice.req("GET", `/media/${vid}/..%2F..%2Fsecret`)).status));
const after = (await alice.query("me")).data.usedBytes as number;
check("quota usage counts HLS output (original deleted)", after > before && after - before < 5 * 1024 * 1024, { before, after });

console.log("Permissions: private video");
check("bob can't see alice's private video", (await bob.query("videos.get", { id: vid })).status === 404);
check("bob can't fetch its media", (await bob.req("GET", ready.urls.hls)).status === 404);
check("bob can't annotate it", (await bob.mutate("annotations.create", { videoId: vid, startMs: 1000, endMs: 6000, x: 0.5, y: 0.5, body: "hi" })).status >= 400);
check("owner can annotate private video", (await alice.mutate("annotations.create", { videoId: vid, startMs: 500, endMs: 3000, x: 0.1, y: 0.2, body: "owner note" })).status === 200);

console.log("Publish + annotations + SSE");
const stream = alice.sse(`/api/videos/${vid}/events`);
await sleep(500);
check("publish", (await alice.mutate("videos.update", { id: vid, visibility: "public", title: "Smoke clip" })).status === 200);
check("bob can view after publish", (await bob.query("videos.get", { id: vid })).data?.can?.annotate === true);
const created = await bob.mutate("annotations.create", { videoId: vid, startMs: 2000, endMs: 99_999, x: 0.25, y: 0.75, body: "Look at this bit" });
check("bob annotates published video", created.status === 200, created.error);
check("span clamped to video duration", created.data?.endMs <= (ready.durationMs ?? 0), created.data);
await sleep(1500);
check("alice received annotation.created via SSE", stream.events.some((e) => e.type === "annotation.created" && e.annotationId === created.data?.id), stream.events);
stream.close();
const list = (await alice.query("annotations.list", { videoId: vid })).data as any[];
check("annotations listed in time order", list.length === 2 && list[0].startMs <= list[1].startMs);
const bobsNote = list.find((a) => a.author.id === "dev-bob");
check("owner may delete bob's note but not edit it", bobsNote?.can.delete === true && bobsNote?.can.edit === false);
check("feed includes published video", ((await bob.query("videos.feed", {})).data.items as any[]).some((v) => v.id === vid));
check("browse search finds it", ((await bob.query("videos.browse", { q: "smoke" })).data.items as any[]).some((v) => v.id === vid));

console.log("Suspension");
check("admin suspends bob", (await admin.mutate("admin.setSuspended", { userId: "dev-bob", suspended: true })).status === 200);
check("suspended bob can't annotate", (await bob.mutate("annotations.create", { videoId: vid, startMs: 0, endMs: 5000, x: 0.5, y: 0.5, body: "x" })).status === 403);
await admin.mutate("admin.setSuspended", { userId: "dev-bob", suspended: false });
check("non-admin can't use admin API", (await bob.query("admin.users", {})).status === 403);

console.log("Quota + malicious upload + transcode path");
const refused = await full.upload(mp4, "nope.mp4");
check("quota-full upload refused before transfer", !refused.ok && refused.status === 413, refused);
const bad = await alice.upload(evil, "evil.m3u8");
const badVideo = bad.videoId ? await waitReady(alice, bad.videoId) : null;
check("playlist upload rejected by worker", badVideo?.status === "failed" && /Unsupported|couldn't be read/.test(badVideo.error ?? ""), badVideo?.error);
const aviUp = await alice.upload(avi, "old-format.avi");
const aviReady = aviUp.videoId ? await waitReady(alice, aviUp.videoId) : null;
check("MPEG-4 Part 2 AVI transcoded to H.264 HLS", aviReady?.status === "ready", aviReady?.error);

console.log("Live streaming");
check("alice sets next stream public", (await alice.mutate("channel.update", { liveVisibility: "public", liveTitle: "Smoke live" })).status === 200);
const badKey = await runFfmpeg(["-re", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "3", "-c:v", "libx264", "-g", "60", "-f", "flv", `${RTMP}/alice?key=wrong`]);
check("wrong stream key rejected", badKey !== 0);
const pusher = ffmpeg([
  "-re", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=330",
  "-t", "20", "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p", "-g", "60",
  "-c:a", "aac", "-f", "flv", `${RTMP}/alice?key=dev`,
]);
const live = await waitFor("live video", async () => {
  const r = await bob.query("videos.liveNow");
  return (r.data as any[] | undefined)?.find((v) => v.owner.id === "dev-alice");
}, 30_000);
check("public stream appears in Live now", !!live);
const master = await waitFor("live playlist", async () => {
  const res = await bob.req("GET", live.urls.hls);
  return res.status === 200 ? res.text() : null;
}, 30_000);
const variant = master.split("\n").find((l) => l && !l.startsWith("#"));
const media = variant ? await (await bob.req("GET", `/live/${live.id}/${variant}`)).text() : master;
check("live HLS has EXT-X-PROGRAM-DATE-TIME (wall-clock timing)", media.includes("#EXT-X-PROGRAM-DATE-TIME"), media.slice(0, 300));
const liveNote = await bob.mutate("annotations.create", { videoId: live.id, startMs: 4000, endMs: 9000, x: 0.5, y: 0.5, body: "live comment" });
check("bob annotates during live", liveNote.status === 200, liveNote.error);
check("bob can't delete the live stream", (await bob.mutate("videos.delete", { id: live.id })).status >= 400);
await new Promise((r) => pusher.on("close", r));
const vod = await waitFor("finalized recording", async () => {
  const r = await alice.query("videos.get", { id: live.id });
  return r.data && (r.data.status === "ready" || r.data.status === "failed") ? r.data : null;
}, 90_000);
check("recording finalized to ready", vod.status === "ready", vod.error);
check("recording duration ≈ 20 s", Math.abs((vod.durationMs ?? 0) - 20_000) < 2500, vod.durationMs);
const vodNotes = (await alice.query("annotations.list", { videoId: live.id })).data as any[];
check("live annotation kept in recording", vodNotes.length === 1 && vodNotes[0].createdDuringLive === true);
check("live annotation within ±1 s of its live time", Math.abs(vodNotes[0].startMs - 4000) <= 1000, vodNotes[0]?.startMs);
check("recording playable", (await bob.req("GET", vod.urls.hls)).status === 200);

console.log("Quota reached mid-stream");
await alice.mutate("channel.update", { liveVisibility: "private", liveTitle: "Quota test" });
const meNow = (await alice.query("me")).data;
await admin.mutate("admin.setQuota", { userId: "dev-alice", quotaBytes: meNow.usedBytes + 3 * 1024 * 1024 });
const t0 = Date.now();
const hog = ffmpeg(["-re", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "60", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "4M", "-g", "60", "-f", "flv", `${RTMP}/alice?key=dev`]);
await new Promise((r) => hog.on("close", r));
check("stream disconnected when quota reached", Date.now() - t0 < 45_000, { seconds: (Date.now() - t0) / 1000 });
const kicked = await waitFor("quota-stopped recording", async () => {
  const lib = (await alice.query("videos.library")).data as any[];
  const v = lib.find((x) => x.title === "Quota test");
  return v && (v.status === "ready" || v.status === "failed") ? v : null;
}, 90_000);
check("partial recording kept", kicked.status === "ready" && kicked.durationMs > 0, kicked.error);
await alice.mutate("videos.delete", { id: kicked.id });
await admin.mutate("admin.setQuota", { userId: "dev-alice", quotaBytes: meNow.quotaBytes });

console.log("Delete + accounting");
const usedBefore = (await alice.query("me")).data.usedBytes;
check("delete video", (await alice.mutate("videos.delete", { id: vid })).status === 200);
const usedAfter = (await alice.query("me")).data.usedBytes;
check("used bytes decrease after delete", usedAfter < usedBefore, { usedBefore, usedAfter });
check("deleted video's media gone", (await alice.req("GET", ready.urls.hls)).status === 404);
await alice.mutate("channel.update", { liveVisibility: "private", liveTitle: "" });

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll smoke checks passed");
process.exit(failures ? 1 : 0);
