import { formatBytes, formatTimecode, quotaState } from "@capturecat/shared";
import { Link } from "@tanstack/react-router";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { timeAgo, type VideoDto } from "../lib";

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  const v: Record<Variant, string> = {
    primary: "bg-accent text-bg hover:bg-accent-strong font-semibold",
    secondary: "bg-surface-2 text-text hover:bg-border border border-border",
    ghost: "text-muted hover:text-text hover:bg-surface-2",
    danger: "bg-red-600/90 text-white hover:bg-red-600",
  };
  const s = size === "sm" ? "px-2.5 py-1 text-sm" : "px-3.5 py-2 text-sm";
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-accent ${v[variant]} ${s} ${className}`}
      {...props}
    />
  );
}

export function Avatar({ name, image, size = 28 }: { name: string; image?: string | null; size?: number }) {
  if (image) return <img src={image} alt="" width={size} height={size} className="rounded-full shrink-0" style={{ width: size, height: size }} />;
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return (
    <span
      aria-hidden
      className="inline-flex items-center justify-center rounded-full shrink-0 font-semibold text-bg"
      style={{ width: size, height: size, background: `hsl(${hue} 70% 65%)`, fontSize: size * 0.45 }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "live" | "accent" | "warn" | "danger" | "ok" }) {
  const t = {
    neutral: "bg-surface-2 text-muted border-border",
    live: "bg-live text-white border-live",
    accent: "bg-accent/15 text-accent border-accent/30",
    warn: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    danger: "bg-red-500/15 text-red-300 border-red-500/30",
    ok: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  }[tone];
  return <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${t}`}>{children}</span>;
}

export function StatusBadge({ v }: { v: Pick<VideoDto, "status" | "visibility" | "progress"> }) {
  return (
    <span className="inline-flex gap-1">
      {v.status === "live" && <Badge tone="live">● Live</Badge>}
      {v.status === "processing" && <Badge tone="warn">Processing {v.progress != null ? `${Math.round(v.progress * 100)}%` : ""}</Badge>}
      {v.status === "failed" && <Badge tone="danger">Failed</Badge>}
      <Badge tone={v.visibility === "public" ? "ok" : "neutral"}>{v.visibility === "public" ? "Public" : "Private"}</Badge>
    </span>
  );
}

export function VideoCard({ v, showStatus = false }: { v: VideoDto; showStatus?: boolean }) {
  return (
    <Link to="/v/$videoId" params={{ videoId: v.id }} className="group block rounded-xl overflow-hidden bg-surface border border-border hover:border-accent/50 transition-colors">
      <div className="relative aspect-video bg-surface-2">
        {v.urls.poster ? (
          <img src={v.urls.poster} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-muted text-sm">
            {v.status === "live" ? "Live now" : v.status === "processing" ? "Processing…" : v.status === "failed" ? "Failed" : ""}
          </div>
        )}
        {v.status === "live" && <span className="absolute left-2 top-2"><Badge tone="live">● Live</Badge></span>}
        {v.durationMs != null && v.status === "ready" && (
          <span className="absolute right-2 bottom-2 rounded bg-black/75 px-1.5 py-0.5 text-xs tabular-nums">{formatTimecode(v.durationMs)}</span>
        )}
        {v.annotationCount > 0 && (
          <span className="absolute left-2 bottom-2 rounded bg-black/75 px-1.5 py-0.5 text-xs">💬 {v.annotationCount}</span>
        )}
        {v.status === "processing" && v.progress != null && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/40">
            <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(v.progress * 100)}%` }} />
          </div>
        )}
      </div>
      <div className="p-3 flex gap-2.5">
        <Avatar name={v.owner.name} image={v.owner.image} />
        <div className="min-w-0">
          <div className="font-medium leading-snug truncate group-hover:text-accent-strong">{v.title}</div>
          <div className="text-xs text-muted mt-0.5 truncate">
            {v.owner.name} · {timeAgo(v.status === "live" ? v.startedAt : (v.publishedAt ?? v.createdAt))}
          </div>
          {showStatus && <div className="mt-1.5"><StatusBadge v={v} /></div>}
        </div>
      </div>
    </Link>
  );
}

export function QuotaBar({ quotaBytes, usedBytes }: { quotaBytes: number; usedBytes: number }) {
  const state = quotaState(quotaBytes, usedBytes);
  const pct = quotaBytes > 0 ? Math.min(100, (usedBytes / quotaBytes) * 100) : 100;
  const color = state === "full" ? "bg-red-500" : state === "warn" ? "bg-amber-400" : "bg-accent";
  return (
    <div>
      <div className="flex justify-between text-xs text-muted mb-1">
        <span>Storage</span>
        <span className="tabular-nums">
          {formatBytes(usedBytes)} of {formatBytes(quotaBytes)}
        </span>
      </div>
      <div className="h-2 rounded-full bg-surface-2 overflow-hidden" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      {state === "warn" && <p className="text-xs text-amber-300 mt-1">You're above 90% of your storage. Delete videos to free space.</p>}
      {state === "full" && <p className="text-xs text-red-300 mt-1">Storage full: uploads and streaming are paused until you free space.</p>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border p-10 text-center">
      <div className="font-medium">{title}</div>
      {children && <div className="text-sm text-muted mt-1">{children}</div>}
    </div>
  );
}

export function Spinner() {
  return <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-accent" role="status" aria-label="Loading" />;
}

export function PageTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
      <h1 className="text-2xl font-semibold tracking-tight">{children}</h1>
      {actions}
    </div>
  );
}

export function VideoGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{children}</div>;
}
