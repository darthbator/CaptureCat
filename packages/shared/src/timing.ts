import {
  DEFAULT_DURATION_MS,
  MAX_DEFAULT_DURATION_MS,
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  PER_WORD_MS,
} from "./constants.js";

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Default on-screen duration for an annotation: 5 s + ~0.3 s/word, capped at 15 s. */
export function defaultDurationMs(body: string): number {
  return Math.min(MAX_DEFAULT_DURATION_MS, DEFAULT_DURATION_MS + wordCount(body) * PER_WORD_MS);
}

/**
 * Normalize an annotation span: integer ms, start >= 0, end > start by at least
 * MIN_DURATION_MS and at most MAX_DURATION_MS, and (when known) inside the video.
 */
export function clampSpan(startMs: number, endMs: number, durationMs?: number | null): { startMs: number; endMs: number } {
  let start = Math.max(0, Math.round(startMs));
  let end = Math.round(endMs);
  if (durationMs != null && durationMs > 0) {
    start = Math.min(start, Math.max(0, durationMs - MIN_DURATION_MS));
    end = Math.min(end, durationMs);
  }
  end = Math.max(end, start + MIN_DURATION_MS);
  end = Math.min(end, start + MAX_DURATION_MS);
  return { startMs: start, endMs: end };
}

/**
 * Live annotation offset: the wall-clock time of the frame being shown (from HLS
 * EXT-X-PROGRAM-DATE-TIME, i.e. the server's clock) minus the stream's start time.
 */
export function liveOffsetMs(playingDate: Date | number, startedAt: Date | number): number {
  const playing = typeof playingDate === "number" ? playingDate : playingDate.getTime();
  const started = typeof startedAt === "number" ? startedAt : startedAt.getTime();
  return Math.max(0, Math.round(playing - started));
}

/** Is an annotation visible at time t (ms)? Half-open interval [start, end). */
export function isActiveAt(a: { startMs: number; endMs: number }, tMs: number): boolean {
  return a.startMs <= tMs && tMs < a.endMs;
}

/** "1:02:03" / "2:03" display format. */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
