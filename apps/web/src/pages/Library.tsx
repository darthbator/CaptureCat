import { checkStorage, formatBytes } from "@capturecat/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import Uppy from "@uppy/core";
import Tus from "@uppy/tus";
import { useEffect, useRef, useState } from "react";
import { Empty, PageTitle, QuotaBar, Spinner, VideoCard, VideoGrid } from "../components/ui";
import { useTRPC } from "../lib";

interface UploadRow {
  id: string;
  name: string;
  size: number;
  progress: number;
  error?: string;
  done?: boolean;
}

export function LibraryPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const me = useQuery(trpc.me.queryOptions());
  const library = useQuery(trpc.videos.library.queryOptions());
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const uppyRef = useRef<Uppy | null>(null);

  // Resumable uploads (tus): an interrupted upload resumes where it stopped.
  useEffect(() => {
    const uppy = new Uppy({ autoProceed: true, restrictions: { allowedFileTypes: ["video/*", ".mkv", ".mov", ".mp4", ".webm", ".avi", ".flv", ".ts"] } }).use(Tus, {
      endpoint: "/api/uploads",
      chunkSize: 16 * 1024 * 1024,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      removeFingerprintOnSuccess: true,
    });
    const patch = (id: string, p: Partial<UploadRow>) => setUploads((rows) => rows.map((r) => (r.id === id ? { ...r, ...p } : r)));
    uppy.on("file-added", (f) => setUploads((rows) => [...rows, { id: f.id, name: f.name ?? "file", size: f.size ?? 0, progress: 0 }]));
    uppy.on("upload-progress", (f, p) => f && p.bytesTotal && patch(f.id, { progress: p.bytesUploaded / p.bytesTotal }));
    uppy.on("upload-success", (f) => {
      if (!f) return;
      patch(f.id, { done: true, progress: 1 });
      void qc.invalidateQueries({ queryKey: trpc.videos.library.queryKey() });
      void qc.invalidateQueries({ queryKey: trpc.me.queryKey() });
      setTimeout(() => setUploads((rows) => rows.filter((r) => r.id !== f.id)), 2500);
    });
    uppy.on("upload-error", (f, err, res) => {
      if (!f) return;
      const body = (res as { body?: unknown } | undefined)?.body;
      const msg = typeof body === "string" && body ? body : err?.message ?? "Upload failed";
      patch(f.id, { error: msg.replace(/^.*response text: /, "").slice(0, 200) });
    });
    uppy.on("restriction-failed", (_f, err) => alert(err.message));
    uppyRef.current = uppy;
    return () => uppy.destroy();
  }, [qc, trpc]);

  const addFiles = (files: FileList | null) => {
    if (!files || !me.data) return;
    for (const file of Array.from(files)) {
      // Check quota up front for a friendly message (the server enforces it too).
      const check = checkStorage({ quotaBytes: me.data.quotaBytes, usedBytes: me.data.usedBytes, incomingBytes: file.size, freeDiskBytes: Infinity, minFreeDiskBytes: 0 });
      if (!check.ok) {
        alert(`${file.name}: ${check.message}`);
        continue;
      }
      try {
        uppyRef.current?.addFile({ name: file.name, type: file.type, data: file, source: "local" });
      } catch {
        /* restriction-failed handler reports it */
      }
    }
  };

  const canUpload = me.data && !me.data.suspended && me.data.quotaState !== "full";

  return (
    <div>
      <PageTitle
        actions={
          <Link to="/studio" className="rounded-lg bg-live/90 hover:bg-live px-3.5 py-2 text-sm font-semibold text-white">
            ● Go live
          </Link>
        }
      >
        Your library
      </PageTitle>

      <div className="grid gap-4 md:grid-cols-[1fr_320px] mb-8">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            if (canUpload) addFiles(e.dataTransfer.files);
          }}
          className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors ${drag ? "border-accent bg-accent/5" : "border-border"} ${canUpload ? "" : "opacity-60"}`}
        >
          <p className="font-medium">Drop video files here</p>
          <p className="text-sm text-muted mt-1">MP4 (H.264/AAC) is processed fastest. Other formats are converted, which takes longer.</p>
          <button
            disabled={!canUpload}
            onClick={() => inputRef.current?.click()}
            className="mt-3 rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-bg hover:bg-accent-strong disabled:opacity-50"
          >
            Choose files
          </button>
          <input ref={inputRef} type="file" accept="video/*,.mkv,.flv,.ts" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ""))} />
          {me.data?.suspended && <p className="text-sm text-red-300 mt-2">Uploading is disabled while your account is suspended.</p>}
          {uploads.length > 0 && (
            <ul className="mt-4 space-y-2 text-left">
              {uploads.map((u) => (
                <li key={u.id} className="rounded-lg bg-surface p-2.5 text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="truncate">{u.name}</span>
                    <span className="text-muted tabular-nums shrink-0">
                      {u.error ? "" : u.done ? "Uploaded, processing…" : `${Math.round(u.progress * 100)}% of ${formatBytes(u.size)}`}
                    </span>
                  </div>
                  {u.error ? (
                    <p className="text-red-300 text-xs mt-1">{u.error}</p>
                  ) : (
                    <div className="h-1.5 rounded-full bg-surface-2 mt-1.5 overflow-hidden">
                      <div className="h-full bg-accent transition-all" style={{ width: `${u.progress * 100}%` }} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-xl border border-border bg-surface p-4 self-start">
          {me.data && <QuotaBar quotaBytes={me.data.quotaBytes} usedBytes={me.data.usedBytes} />}
          <p className="text-xs text-muted mt-3">New videos are private. Open one and make it public to put it in the feed.</p>
        </div>
      </div>

      {library.isPending ? (
        <Spinner />
      ) : library.data?.length === 0 ? (
        <Empty title="No videos yet">Upload a recording or go live to get started.</Empty>
      ) : (
        <VideoGrid>
          {library.data?.map((v) => (
            <VideoCard key={v.id} v={v} showStatus />
          ))}
        </VideoGrid>
      )}
    </div>
  );
}
