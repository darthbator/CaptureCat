import {
  ANNOTATION_BODY_MAX,
  clampSpan,
  contentRect,
  defaultDurationMs,
  elementPointToNormalized,
  formatTimecode,
  isActiveAt,
  MAX_DURATION_MS,
  normalizedToElementPoint,
  type Rect,
} from "@capturecat/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent } from "react";
import { Badge, Button } from "../components/ui";
import { errorMessage, useTRPC, type AnnotationDto, type VideoDto } from "../lib";
import { AnnotationPanel } from "./AnnotationPanel";
import { loadThumbs, type ThumbCue } from "./thumbs";
import { Timeline, type Draft } from "./Timeline";
import { useMediaClock } from "./useMediaClock";

interface ComposerState extends Draft {
  body: string;
  /** True once the user changed the end time by hand (stops auto-sizing by word count). */
  manualEnd: boolean;
}

export function Player({ video }: { video: VideoDto }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const live = video.status === "live";
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const clock = useMediaClock(videoRef, video.urls.hls, { live, startedAt: video.startedAt, durationMs: video.durationMs });

  const annotationsQuery = useQuery(trpc.annotations.list.queryOptions({ videoId: video.id }));
  const annotations = useMemo(() => annotationsQuery.data ?? [], [annotationsQuery.data]);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [holding, setHolding] = useState(false);
  const [rect, setRect] = useState<Rect>({ x: 0, y: 0, width: 0, height: 0 });
  const [thumbs, setThumbs] = useState<ThumbCue[]>([]);
  const [fullscreen, setFullscreen] = useState(false);

  // Real-time updates for this video (annotations from other viewers, status changes).
  useEffect(() => {
    const es = new EventSource(`/api/videos/${video.id}/events`);
    const refreshAnnotations = () => qc.invalidateQueries({ queryKey: trpc.annotations.list.queryKey({ videoId: video.id }) });
    es.addEventListener("annotation.created", refreshAnnotations);
    es.addEventListener("annotation.updated", refreshAnnotations);
    es.addEventListener("annotation.deleted", refreshAnnotations);
    es.addEventListener("video.updated", () => qc.invalidateQueries({ queryKey: trpc.videos.get.queryKey({ id: video.id }) }));
    return () => es.close();
  }, [video.id, qc, trpc]);

  useEffect(() => {
    if (video.urls.thumbnails) void loadThumbs(video.urls.thumbnails).then(setThumbs);
  }, [video.urls.thumbnails]);

  // Track where the frame is drawn inside the <video> element (letterboxing).
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const el = videoRef.current;
    if (!stage || !el) return;
    const measure = () => setRect(contentRect(stage.clientWidth, stage.clientHeight, el.videoWidth || video.width || 0, el.videoHeight || video.height || 0));
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    el.addEventListener("loadedmetadata", measure);
    el.addEventListener("resize", measure);
    measure();
    return () => {
      ro.disconnect();
      el.removeEventListener("loadedmetadata", measure);
      el.removeEventListener("resize", measure);
    };
  }, [video.width, video.height]);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === wrapperRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const now = clock.nowMs ?? 0;
  const activeIds = useMemo(() => new Set(annotations.filter((a) => isActiveAt(a, now)).map((a) => a.id)), [annotations, now]);

  // "Hold to extend": while held, the draft's end follows the playhead.
  useEffect(() => {
    if (!holding || clock.nowMs == null) return;
    setComposer((c) => (c && clock.nowMs! > c.endMs ? { ...c, endMs: Math.min(clock.nowMs!, c.startMs + MAX_DURATION_MS), manualEnd: true } : c));
  }, [holding, clock.nowMs]);

  const showNotice = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((n) => (n === msg ? null : n)), 4000);
  };

  const select = useCallback(
    (a: AnnotationDto) => {
      const ok = clock.seek(a.startMs);
      if (!ok) {
        showNotice("That moment is outside the live buffer. It will be in the recording when the stream ends.");
        return;
      }
      clock.pause();
      setFlashId(a.id);
      setTimeout(() => setFlashId((f) => (f === a.id ? null : f)), 1500);
    },
    [clock],
  );

  /** Click on the video surface drops a pin and opens the composer. */
  const onStageClick = (e: RMouseEvent<HTMLDivElement>) => {
    if (!video.can.annotate) {
      clock.toggle();
      return;
    }
    if (composer) return;
    const box = stageRef.current!.getBoundingClientRect();
    const point = elementPointToNormalized(e.clientX - box.left, e.clientY - box.top, rect);
    if (!point) return; // clicked the letterbox bars
    const start = clock.readNow();
    if (start == null) {
      showNotice("Wait for the stream to start playing, then click again.");
      return;
    }
    // Recorded video pauses; a live stream keeps playing (the time is fixed at the click).
    if (!live) clock.pause();
    setComposer({ ...point, startMs: start, endMs: start + defaultDurationMs(""), body: "", manualEnd: false });
  };

  const create = useMutation(
    trpc.annotations.create.mutationOptions({
      onSuccess: () => {
        setComposer(null);
        void qc.invalidateQueries({ queryKey: trpc.annotations.list.queryKey({ videoId: video.id }) });
      },
    }),
  );

  const submit = () => {
    if (!composer || !composer.body.trim()) return;
    const span = clampSpan(composer.startMs, composer.endMs, live ? null : clock.totalMs || video.durationMs);
    create.mutate({ videoId: video.id, x: composer.x, y: composer.y, body: composer.body.trim(), ...span });
  };

  // Keyboard: space/k play-pause, arrows ±5 s, escape cancels the composer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) {
        if (e.key === "Escape") setComposer(null);
        return;
      }
      if (!wrapperRef.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      if (e.key === " " || e.key === "k") {
        e.preventDefault();
        clock.toggle();
      } else if (e.key === "ArrowRight") clock.seek(now + 5000);
      else if (e.key === "ArrowLeft") clock.seek(Math.max(0, now - 5000));
      else if (e.key === "Escape") setComposer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clock, now]);

  const pins: { id: string; x: number; y: number; body: string; author: string; flash: boolean; draft?: boolean }[] = annotations
    .filter((a) => activeIds.has(a.id) || a.id === flashId)
    .map((a) => ({ id: a.id, x: a.x, y: a.y, body: a.body, author: a.author.name, flash: a.id === flashId }));
  if (composer) pins.push({ id: "draft", x: composer.x, y: composer.y, body: composer.body || "New annotation", author: "You", flash: false, draft: true });

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrapperRef.current?.requestFullscreen();
  };

  return (
    <div ref={wrapperRef} className="player-wrapper grid gap-4 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_340px] lg:items-stretch">
      <div className="min-w-0">
        <div className="rounded-xl overflow-hidden bg-black border border-border">
          <div
            ref={stageRef}
            data-testid="player-stage"
            className={`relative aspect-video ${video.can.annotate && !composer ? "cursor-crosshair" : ""}`}
            onClick={onStageClick}
            onDoubleClick={toggleFullscreen}
          >
            <video
              ref={videoRef}
              className="absolute inset-0 h-full w-full object-contain"
              playsInline
              preload="metadata"
              poster={video.urls.poster ?? undefined}
            />
            {/* Pins overlay, positioned in frame coordinates */}
            <div className="absolute inset-0 pointer-events-none">
              {pins.map((p) => {
                const pos = normalizedToElementPoint(p.x, p.y, rect);
                const right = p.x > 0.6;
                return (
                  <div key={p.id} className="absolute" style={{ left: pos.left, top: pos.top }}>
                    {p.flash && <span className="pin-flash absolute left-0 top-0 h-6 w-6 rounded-full bg-sky-400" />}
                    <span
                      className={`absolute left-0 top-0 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-lg ${
                        p.draft ? "bg-emerald-400 animate-pulse" : "bg-sky-500"
                      }`}
                    />
                    <div
                      className={`absolute top-3 ${right ? "right-3" : "left-3"} w-max max-w-[min(260px,40vw)] rounded-lg bg-black/80 backdrop-blur px-2.5 py-1.5 text-xs sm:text-sm shadow-xl border ${
                        p.draft ? "border-emerald-400/60" : "border-white/10"
                      }`}
                    >
                      <span className={`font-semibold ${p.draft ? "text-emerald-300" : "text-sky-300"}`}>{p.author}</span>
                      <p className="whitespace-pre-wrap break-words line-clamp-4">{p.body}</p>
                    </div>
                  </div>
                );
              })}
            </div>
            {clock.error && <div className="absolute inset-0 grid place-items-center bg-black/70 text-sm text-red-300">{clock.error}</div>}
            {notice && (
              <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-lg bg-black/85 px-3 py-2 text-sm shadow-xl border border-border pointer-events-none">{notice}</div>
            )}
          </div>

          {/* Controls */}
          <div className="px-3 pb-2 bg-surface">
            <Timeline
              totalMs={live ? clock.totalMs : clock.totalMs || video.durationMs || 0}
              nowMs={clock.nowMs}
              annotations={annotations}
              activeIds={activeIds}
              draft={composer}
              liveWindow={clock.window}
              thumbs={thumbs}
              onSeek={(ms) => {
                if (!clock.seek(ms)) showNotice("That part of the stream is no longer buffered. It will be in the recording.");
              }}
              onDraftEnd={(ms) =>
                setComposer((c) => (c ? { ...c, endMs: Math.min(Math.max(ms, c.startMs + 500), c.startMs + MAX_DURATION_MS), manualEnd: true } : c))
              }
              onSelect={select}
            />
            <div className="flex items-center gap-2 text-sm">
              <Button size="sm" variant="ghost" onClick={clock.toggle} aria-label={clock.playing ? "Pause" : "Play"}>
                {clock.playing ? "❚❚" : "▶"}
              </Button>
              <Button size="sm" variant="ghost" onClick={clock.toggleMute} aria-label={clock.muted ? "Unmute" : "Mute"}>
                {clock.muted || clock.volume === 0 ? "🔇" : "🔊"}
              </Button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={clock.muted ? 0 : clock.volume}
                onChange={(e) => clock.setVolume(Number(e.target.value))}
                className="w-20 accent-[var(--color-accent)] hidden sm:block"
                aria-label="Volume"
              />
              <span className="tabular-nums text-muted">
                {formatTimecode(now)}
                {!live && ` / ${formatTimecode(clock.totalMs || video.durationMs || 0)}`}
              </span>
              {live && (
                <span className="ml-1">
                  {clock.behindLiveMs > 4000 ? (
                    <Button size="sm" variant="secondary" onClick={clock.goLive}>
                      ⏭ Back to live
                    </Button>
                  ) : (
                    <Badge tone="live">● Live</Badge>
                  )}
                </span>
              )}
              <span className="ml-auto" />
              <Button size="sm" variant="ghost" onClick={toggleFullscreen} aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}>
                {fullscreen ? "⤡" : "⤢"}
              </Button>
            </div>
          </div>
        </div>

        {/* Composer */}
        {composer && (
          <form
            className="mt-3 rounded-xl border border-emerald-400/40 bg-surface p-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted mb-2">
              <span>
                New annotation at <span className="font-mono text-emerald-300">{formatTimecode(composer.startMs)}</span>
              </span>
              <span>
                on screen for <span className="font-mono text-emerald-300">{((composer.endMs - composer.startMs) / 1000).toFixed(1)} s</span>
              </span>
              {live && <span>The stream keeps playing while you type.</span>}
            </div>
            <textarea
              autoFocus
              rows={2}
              maxLength={ANNOTATION_BODY_MAX}
              placeholder="What's happening here?"
              className="w-full rounded-lg bg-bg border border-border p-2.5 text-sm focus:outline-none focus:border-emerald-400/60"
              value={composer.body}
              onChange={(e) => {
                const body = e.target.value;
                setComposer((c) => (c ? { ...c, body, endMs: c.manualEnd ? c.endMs : c.startMs + defaultDurationMs(body) } : c));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
              }}
            />
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <span className="text-xs text-muted mr-1">Extend:</span>
              <Button size="sm" type="button" onClick={() => setComposer((c) => c && { ...c, endMs: Math.min(c.endMs + 2000, c.startMs + MAX_DURATION_MS), manualEnd: true })}>
                +2s
              </Button>
              <Button size="sm" type="button" onClick={() => setComposer((c) => c && { ...c, endMs: Math.min(c.endMs + 5000, c.startMs + MAX_DURATION_MS), manualEnd: true })}>
                +5s
              </Button>
              <Button
                size="sm"
                type="button"
                variant={holding ? "primary" : "secondary"}
                title="Press and hold: the video plays and the annotation lasts until you let go"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setHolding(true);
                  if (!live) clock.play();
                }}
                onPointerUp={() => {
                  setHolding(false);
                  if (!live) clock.pause();
                }}
                onPointerCancel={() => setHolding(false)}
              >
                {holding ? "Release to stop" : "Hold to extend"}
              </Button>
              <span className="ml-auto" />
              <Button size="sm" variant="ghost" type="button" onClick={() => setComposer(null)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" disabled={!composer.body.trim() || create.isPending}>
                Post
              </Button>
            </div>
            {create.error && <p className="text-xs text-red-300 mt-2">{errorMessage(create.error)}</p>}
            <p className="text-[11px] text-muted mt-1.5">Tip: drag the green handle on the timeline to set the end. Ctrl+Enter posts.</p>
          </form>
        )}
      </div>

      {/* On desktop the panel matches the player's height (absolute, so a long list can't grow the row). */}
      <div className="min-h-0 min-w-0 lg:relative">
        <div className="lg:absolute lg:inset-0">
          <AnnotationPanel videoId={video.id} annotations={annotations} activeIds={activeIds} onSelect={select} canAnnotate={video.can.annotate} />
        </div>
      </div>
    </div>
  );
}
