import { spawn } from "node:child_process";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import ffmpegStatic from "ffmpeg-static";

/** Binaries: env override (Docker image installs ffmpeg), else the npm-provided builds. */
export const FFMPEG = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string);
export const FFPROBE = process.env.FFPROBE_PATH || ffprobeInstaller.path;

/**
 * Demuxers we accept for uploads. Playlist-style formats (hls, concat, etc.) are rejected:
 * a crafted playlist could make ffmpeg read other local files or fetch URLs.
 */
const ALLOWED_DEMUXERS = new Set(["mov", "mp4", "m4a", "3gp", "3g2", "mj2", "matroska", "webm", "avi", "flv", "mpegts", "asf"]);

/** Only local files may be opened, never network protocols. */
const INPUT_GUARD = ["-protocol_whitelist", "file"];

export interface ProbeStream {
  index: number;
  codec_type: "video" | "audio" | "subtitle" | "data";
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
}

export interface ProbeResult {
  format: { format_name: string; duration?: string };
  streams: ProbeStream[];
}

export class MediaError extends Error {}

function run(bin: string, args: string[], onStdout?: (chunk: string) => void): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Argument array, never a shell string.
    const child = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
      onStdout?.(d);
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr = (stderr + d).slice(-20_000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${bin.split(/[\\/]/).pop()} exited with ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`));
    });
  });
}

/** Probe an input. `demuxer` forces a format (used for our own concat lists). */
export async function probe(input: string, opts: { demuxer?: string; concat?: boolean } = {}): Promise<ProbeResult> {
  const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", ...INPUT_GUARD];
  if (opts.concat) args.push("-f", "concat", "-safe", "0");
  else if (opts.demuxer) args.push("-f", opts.demuxer);
  args.push("-i", input);
  const { stdout } = await run(FFPROBE, args);
  return JSON.parse(stdout) as ProbeResult;
}

/** Validate an untrusted upload; returns the demuxer to force for every later ffmpeg call. */
export function validateUpload(p: ProbeResult): string {
  const names = p.format.format_name.split(",");
  const demuxer = names.find((n) => ALLOWED_DEMUXERS.has(n));
  if (!demuxer || names.some((n) => !ALLOWED_DEMUXERS.has(n))) {
    throw new MediaError(`Unsupported file format (${p.format.format_name}). Upload a video file such as MP4, MOV, MKV or WebM.`);
  }
  if (!p.streams.some((s) => s.codec_type === "video")) throw new MediaError("The file has no video track.");
  return demuxer;
}

export function videoStream(p: ProbeResult) {
  return p.streams.find((s) => s.codec_type === "video")!;
}

export function durationMs(p: ProbeResult): number {
  const d = Number(p.format.duration);
  return Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : 0;
}

/** H.264 + (AAC or no audio) can be copied into HLS without re-encoding. */
export function canRemux(p: ProbeResult): boolean {
  const v = videoStream(p);
  const a = p.streams.find((s) => s.codec_type === "audio");
  const videoOk = v.codec_name === "h264" && (!v.pix_fmt || v.pix_fmt === "yuv420p" || v.pix_fmt === "yuvj420p");
  return videoOk && (!a || a.codec_name === "aac");
}

export interface InputSpec {
  path: string;
  demuxer?: string;
  concat?: boolean;
}

function inputArgs(input: InputSpec): string[] {
  const args = [...INPUT_GUARD];
  if (input.concat) args.push("-f", "concat", "-safe", "0");
  else if (input.demuxer) args.push("-f", input.demuxer);
  args.push("-i", input.path);
  return args;
}

/**
 * Package as single-rendition HLS (fMP4/CMAF). Remux with -c copy when possible;
 * otherwise CPU transcode (no GPU on this server). Calls onProgress with 0..1.
 */
export async function toHls(
  input: InputSpec,
  outDir: string,
  opts: { remux: boolean; durationMs: number; onProgress?: (p: number) => void },
): Promise<void> {
  const codec = opts.remux
    ? ["-c", "copy"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-g", "60", "-c:a", "aac", "-b:a", "160k", "-ac", "2"];
  const args = [
    "-hide_banner",
    "-y",
    ...inputArgs(input),
    "-map", "0:v:0",
    "-map", "0:a:0?",
    ...codec,
    "-f", "hls",
    "-hls_time", "4",
    "-hls_playlist_type", "vod",
    "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", `${outDir}/seg_%05d.m4s`,
    "-progress", "pipe:1",
    "-nostats",
    `${outDir}/index.m3u8`,
  ];
  let buffer = "";
  await run(FFMPEG, args, (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const m = /^out_time_us=(\d+)/.exec(line.trim());
      if (m && opts.durationMs > 0) opts.onProgress?.(Math.min(0.99, Number(m[1]) / 1000 / opts.durationMs));
    }
  });
}

/** Poster frame (JPEG, max 1280 wide). */
export async function poster(input: InputSpec, outFile: string, atMs: number): Promise<void> {
  await run(FFMPEG, [
    "-hide_banner", "-y",
    "-ss", (atMs / 1000).toFixed(3),
    ...inputArgs(input),
    "-frames:v", "1",
    "-vf", "scale='min(1280,iw)':-2",
    "-q:v", "3",
    outFile,
  ]);
}

export const THUMB_W = 160;
export const THUMB_H = 90;
export const SPRITE_COLS = 10;

/**
 * Scrub thumbnails: one sprite sheet (max 100 tiles) + WebVTT mapping time ranges to tiles.
 * Decodes keyframes only, so it's cheap even on CPU.
 */
export async function sprite(input: InputSpec, outDir: string, durationMs: number): Promise<string> {
  const intervalS = Math.max(2, Math.ceil(durationMs / 1000 / 100));
  const count = Math.max(1, Math.ceil(durationMs / 1000 / intervalS));
  const rows = Math.ceil(count / SPRITE_COLS);
  await run(FFMPEG, [
    "-hide_banner", "-y",
    "-skip_frame", "nokey",
    ...inputArgs(input),
    "-vf",
    `fps=1/${intervalS},scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=decrease,pad=${THUMB_W}:${THUMB_H}:(ow-iw)/2:(oh-ih)/2,tile=${SPRITE_COLS}x${rows}`,
    "-frames:v", "1",
    "-q:v", "5",
    `${outDir}/sprite.jpg`,
  ]);
  const cues = ["WEBVTT", ""];
  for (let i = 0; i < count; i++) {
    const start = i * intervalS * 1000;
    const end = Math.min((i + 1) * intervalS * 1000, durationMs);
    const x = (i % SPRITE_COLS) * THUMB_W;
    const y = Math.floor(i / SPRITE_COLS) * THUMB_H;
    cues.push(`${vttTime(start)} --> ${vttTime(end)}`, `sprite.jpg#xywh=${x},${y},${THUMB_W},${THUMB_H}`, "");
  }
  return cues.join("\n");
}

function vttTime(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const f = Math.floor(ms % 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(f).padStart(3, "0")}`;
}
