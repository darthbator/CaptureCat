import { liveOffsetMs } from "@capturecat/shared";
import Hls from "hls.js";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface MediaClock {
  /** Current position in ms from the video's first frame (stream time when live). */
  nowMs: number | null;
  playing: boolean;
  /** VOD: duration. Live: stream time at the live edge. */
  totalMs: number;
  /** Live only: the seekable window in stream time. */
  window: { startMs: number; endMs: number } | null;
  /** Live only: how far behind the live edge playback is. */
  behindLiveMs: number;
  muted: boolean;
  volume: number;
  error: string | null;
  play(): void;
  pause(): void;
  toggle(): void;
  /** Seek to a stream-time position; returns false if it's outside the live buffer. */
  seek(ms: number): boolean;
  goLive(): void;
  setVolume(v: number): void;
  toggleMute(): void;
  /** Read the clock right now (not throttled), e.g. at click time. */
  readNow(): number | null;
}

/**
 * Attaches HLS (hls.js, or native on Safari) and exposes a unified clock.
 * VOD time = currentTime. Live time = wall clock of the current frame (EXT-X-PROGRAM-DATE-TIME,
 * the server's clock) minus the stream's start, so every viewer agrees on annotation times
 * regardless of their own clock or latency.
 */
export function useMediaClock(
  videoRef: RefObject<HTMLVideoElement | null>,
  src: string | null,
  opts: { live: boolean; startedAt: string | null; durationMs: number | null },
): MediaClock {
  const hlsRef = useRef<Hls | null>(null);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [totalMs, setTotalMs] = useState(opts.durationMs ?? 0);
  const [win, setWin] = useState<{ startMs: number; endMs: number } | null>(null);
  const [muted, setMuted] = useState(false);
  const [volume, setVol] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const startedAtMs = opts.startedAt ? new Date(opts.startedAt).getTime() : null;

  const readNow = useCallback((): number | null => {
    const el = videoRef.current;
    if (!el) return null;
    if (!opts.live) return Math.round(el.currentTime * 1000);
    if (startedAtMs == null) return null;
    const hlsDate = hlsRef.current?.playingDate;
    if (hlsDate) return liveOffsetMs(hlsDate, startedAtMs);
    // Safari native HLS exposes the PROGRAM-DATE-TIME of currentTime=0 via getStartDate().
    const start = (el as HTMLVideoElement & { getStartDate?: () => Date }).getStartDate?.();
    if (start && !Number.isNaN(start.getTime())) return liveOffsetMs(start.getTime() + el.currentTime * 1000, startedAtMs);
    return null;
  }, [opts.live, startedAtMs, videoRef]);

  // Attach the source.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !src) return;
    setError(null);
    if (Hls.isSupported()) {
      const hls = new Hls({
        lowLatencyMode: opts.live,
        backBufferLength: opts.live ? 120 : 60,
        liveDurationInfinity: true,
      });
      hlsRef.current = hls;
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          setError(data.type === Hls.ErrorTypes.NETWORK_ERROR ? "Couldn't load the video stream." : "Playback error.");
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        }
      });
      hls.loadSource(src);
      hls.attachMedia(el);
      if (opts.live) hls.once(Hls.Events.MANIFEST_PARSED, () => void el.play().catch(() => {}));
      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    }
    if (el.canPlayType("application/vnd.apple.mpegurl")) {
      el.src = src;
      if (opts.live) void el.play().catch(() => {});
      return () => {
        el.removeAttribute("src");
        el.load();
      };
    }
    setError("This browser can't play HLS video.");
  }, [src, opts.live, videoRef]);

  // Tick the clock (~15 Hz while playing; on events otherwise).
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const update = () => {
      const now = readNow();
      setNowMs(now);
      if (!opts.live) {
        if (Number.isFinite(el.duration) && el.duration > 0) setTotalMs(Math.round(el.duration * 1000));
        setWin(null);
      } else if (now != null && el.seekable.length > 0) {
        const s = el.seekable.start(0);
        const e = el.seekable.end(el.seekable.length - 1);
        const endMs = Math.round(now + (e - el.currentTime) * 1000);
        setWin({ startMs: Math.max(0, Math.round(now + (s - el.currentTime) * 1000)), endMs });
        setTotalMs(Math.max(endMs, now));
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      update();
    };
    const onVol = () => {
      setMuted(el.muted);
      setVol(el.volume);
    };
    const evs = ["timeupdate", "seeked", "loadedmetadata", "durationchange"] as const;
    evs.forEach((e) => el.addEventListener(e, update));
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("volumechange", onVol);
    const timer = setInterval(() => {
      if (!el.paused || opts.live) update();
    }, 66);
    return () => {
      evs.forEach((e) => el.removeEventListener(e, update));
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("volumechange", onVol);
      clearInterval(timer);
    };
  }, [readNow, opts.live, videoRef]);

  const seek = useCallback(
    (ms: number): boolean => {
      const el = videoRef.current;
      if (!el) return false;
      if (!opts.live) {
        el.currentTime = Math.max(0, ms / 1000);
        return true;
      }
      const now = readNow();
      if (now == null || el.seekable.length === 0) return false;
      const target = el.currentTime + (ms - now) / 1000;
      const s = el.seekable.start(0);
      const e = el.seekable.end(el.seekable.length - 1);
      if (target < s - 0.25 || target > e + 0.25) return false;
      el.currentTime = Math.min(e, Math.max(s, target));
      return true;
    },
    [opts.live, readNow, videoRef],
  );

  const el = () => videoRef.current;
  return {
    nowMs,
    playing,
    totalMs,
    window: win,
    behindLiveMs: opts.live && win && nowMs != null ? Math.max(0, win.endMs - nowMs) : 0,
    muted,
    volume,
    error,
    play: () => void el()?.play().catch(() => {}),
    pause: () => el()?.pause(),
    toggle: () => {
      const v = el();
      if (!v) return;
      if (v.paused) void v.play().catch(() => {});
      else v.pause();
    },
    seek,
    goLive: () => {
      const v = el();
      if (!v) return;
      const pos = hlsRef.current?.liveSyncPosition ?? (v.seekable.length ? v.seekable.end(v.seekable.length - 1) : null);
      if (pos != null) v.currentTime = pos;
      void v.play().catch(() => {});
    },
    setVolume: (v: number) => {
      const e = el();
      if (!e) return;
      e.volume = v;
      e.muted = v === 0;
    },
    toggleMute: () => {
      const e = el();
      if (e) e.muted = !e.muted;
    },
    readNow,
  };
}
