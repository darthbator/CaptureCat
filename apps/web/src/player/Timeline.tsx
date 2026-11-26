import { clusterPositions, formatTimecode } from "@capturecat/shared";
import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import type { AnnotationDto } from "../lib";
import { cueAt, type ThumbCue } from "./thumbs";

export interface Draft {
  x: number;
  y: number;
  startMs: number;
  endMs: number;
}

interface Props {
  totalMs: number;
  nowMs: number | null;
  annotations: AnnotationDto[];
  activeIds: Set<string>;
  draft: Draft | null;
  liveWindow: { startMs: number; endMs: number } | null;
  thumbs: ThumbCue[];
  onSeek(ms: number): void;
  onDraftEnd(ms: number): void;
  onSelect(a: AnnotationDto): void;
}

const MARKER_GAP_PX = 10;

/**
 * Scrubber with annotation markers (clustered when dense), shaded spans for active
 * annotations, the draft span with a draggable end handle, and hover previews
 * (scrub thumbnail + comment text).
 */
export function Timeline({ totalMs, nowMs, annotations, activeIds, draft, liveWindow, thumbs, onSeek, onDraftEnd, onSelect }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ px: number; ms: number; cluster?: AnnotationDto[] } | null>(null);
  const draggingEnd = useRef(false);

  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const span = Math.max(totalMs, 1);
  const toPx = (ms: number) => (Math.min(Math.max(ms, 0), span) / span) * width;
  const pctOf = (ms: number) => `${(Math.min(Math.max(ms, 0), span) / span) * 100}%`;
  const msAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * span);
  };

  const clusters = useMemo(
    () =>
      clusterPositions(
        annotations.map((a) => toPx(a.startMs)),
        MARKER_GAP_PX,
      ).map((c) => ({ at: c.at, items: c.members.map((i) => annotations[i]!) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [annotations, width, span],
  );

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).dataset.handle === "draft-end") {
      draggingEnd.current = true;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if ((e.target as HTMLElement).closest("[data-marker]")) return;
    onSeek(msAt(e.clientX));
  };
  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (draggingEnd.current) {
      onDraftEnd(msAt(e.clientX));
      return;
    }
    const ms = msAt(e.clientX);
    setHover((h) => ({ px: toPx(ms), ms, cluster: h?.cluster && h.px === toPx(ms) ? h.cluster : undefined }));
  };
  const onPointerUp = () => {
    draggingEnd.current = false;
  };

  const activeSpans = annotations.filter((a) => activeIds.has(a.id));
  const cue = hover && thumbs.length ? cueAt(thumbs, hover.ms) : undefined;

  return (
    <div className="relative select-none pt-1.5 pb-1">
      <div
        ref={trackRef}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(span / 1000)}
        aria-valuenow={Math.round((nowMs ?? 0) / 1000)}
        tabIndex={0}
        className="relative h-7 cursor-pointer group touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => !draggingEnd.current && setHover(null)}
      >
        {/* track */}
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 group-hover:h-2 transition-all rounded-full bg-white/15 overflow-hidden">
          {liveWindow && (
            <div className="absolute inset-y-0 bg-white/10" style={{ left: pctOf(liveWindow.startMs), width: `calc(${pctOf(liveWindow.endMs)} - ${pctOf(liveWindow.startMs)})` }} />
          )}
          <div className="absolute inset-y-0 left-0 bg-accent/80" style={{ width: pctOf(nowMs ?? 0) }} />
          {activeSpans.map((a) => (
            <div key={a.id} className="absolute inset-y-0 bg-sky-400/60" style={{ left: pctOf(a.startMs), width: `calc(${pctOf(a.endMs)} - ${pctOf(a.startMs)})` }} />
          ))}
          {draft && (
            <div className="absolute inset-y-0 bg-emerald-400/70" style={{ left: pctOf(draft.startMs), width: `calc(${pctOf(draft.endMs)} - ${pctOf(draft.startMs)})` }} />
          )}
        </div>

        {/* playhead */}
        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-3.5 w-3.5 rounded-full bg-accent shadow pointer-events-none" style={{ left: pctOf(nowMs ?? 0) }} />

        {/* annotation markers */}
        {clusters.map((c) => {
          const active = c.items.some((a) => activeIds.has(a.id));
          return (
            <button
              key={c.items[0]!.id}
              data-marker
              type="button"
              aria-label={c.items.length > 1 ? `${c.items.length} annotations at ${formatTimecode(c.items[0]!.startMs)}` : `Annotation at ${formatTimecode(c.items[0]!.startMs)}: ${c.items[0]!.body}`}
              className={`absolute top-0 -translate-x-1/2 grid place-items-center rounded-full border text-[9px] font-bold leading-none transition-transform hover:scale-125 ${
                active ? "bg-sky-400 border-sky-200 text-bg" : "bg-surface border-sky-400 text-sky-300"
              } ${c.items.length > 1 ? "h-4 min-w-4 px-0.5" : "h-2.5 w-2.5"}`}
              style={{ left: c.at }}
              onPointerEnter={() => setHover({ px: c.at, ms: c.items[0]!.startMs, cluster: c.items })}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(c.items[0]!);
              }}
            >
              {c.items.length > 1 ? c.items.length : ""}
            </button>
          );
        })}

        {/* draft end handle */}
        {draft && (
          <div
            data-handle="draft-end"
            title="Drag to change how long the annotation stays on screen"
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-5 w-2 rounded bg-emerald-300 border border-emerald-100 cursor-ew-resize"
            style={{ left: pctOf(draft.endMs) }}
          />
        )}
      </div>

      {/* hover preview */}
      {hover && width > 0 && (
        <div
          className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 z-20 rounded-lg bg-black/90 border border-border p-1.5 text-xs shadow-xl"
          style={{ left: Math.min(Math.max(hover.px, 90), width - 90), maxWidth: 220 }}
        >
          {cue && (
            <div
              className="rounded mb-1"
              style={{ width: cue.w, height: cue.h, backgroundImage: `url(${cue.url})`, backgroundPosition: `-${cue.x}px -${cue.y}px` }}
            />
          )}
          {hover.cluster?.slice(0, 3).map((a) => (
            <div key={a.id} className="mb-1 last:mb-0">
              <span className="font-semibold text-sky-300">{a.author.name}:</span> <span className="line-clamp-2">{a.body}</span>
            </div>
          ))}
          {hover.cluster && hover.cluster.length > 3 && <div className="text-muted">+{hover.cluster.length - 3} more</div>}
          <div className="text-center tabular-nums text-muted">{formatTimecode(hover.ms)}</div>
        </div>
      )}
    </div>
  );
}
