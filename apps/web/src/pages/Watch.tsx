import { formatBytes } from "@capturecat/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { Avatar, Badge, Button, Empty, Spinner, StatusBadge } from "../components/ui";
import { errorMessage, timeAgo, useTRPC, type VideoDto } from "../lib";
import { Player } from "../player/Player";

export function WatchPage() {
  const { videoId } = useParams({ from: "/app/v/$videoId" });
  const trpc = useTRPC();
  const video = useQuery(trpc.videos.get.queryOptions({ id: videoId }, { refetchInterval: (q) => (q.state.data?.status === "processing" ? 3000 : false) }));

  if (video.isPending) return <Spinner />;
  if (video.error || !video.data) return <Empty title="Video not found">It may be private, or it was deleted.</Empty>;
  const v = video.data;

  return (
    <div className="space-y-5">
      {v.status === "live" || v.status === "ready" ? (
        // Remount when the status changes (live → recording) so the source switches cleanly.
        <Player key={`${v.id}:${v.status}`} video={v} />
      ) : v.status === "processing" ? (
        <div className="aspect-video max-h-[70vh] rounded-xl border border-border bg-surface grid place-items-center">
          <div className="text-center">
            <Spinner />
            <p className="mt-3 font-medium">{v.source === "live" ? "Finalizing the recording…" : "Processing your video…"}</p>
            {v.progress != null && <p className="text-sm text-muted tabular-nums">{Math.round(v.progress * 100)}%</p>}
            <p className="text-xs text-muted mt-1">Annotations made during the stream are kept.</p>
          </div>
        </div>
      ) : (
        <div className="aspect-video max-h-[70vh] rounded-xl border border-red-500/40 bg-surface grid place-items-center p-6 text-center">
          <div>
            <p className="font-medium text-red-300">Processing failed</p>
            <p className="text-sm text-muted mt-1">{v.error}</p>
          </div>
        </div>
      )}
      <VideoDetails v={v} />
    </div>
  );
}

function VideoDetails({ v }: { v: VideoDto }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(v.title);
  const [description, setDescription] = useState(v.description);
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.videos.pathKey() });
  const update = useMutation(trpc.videos.update.mutationOptions({ onSuccess: () => (setEditing(false), refresh()) }));
  const del = useMutation(trpc.videos.delete.mutationOptions({ onSuccess: () => (refresh(), navigate({ to: "/library" })) }));
  const retry = useMutation(trpc.videos.retry.mutationOptions({ onSuccess: refresh }));
  const err = update.error ?? del.error ?? retry.error;

  return (
    <div className="grid gap-4 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0">
        {editing ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate({ id: v.id, title, description });
            }}
          >
            <input className="w-full rounded-lg bg-surface border border-border px-3 py-2 text-lg font-semibold" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
            <textarea className="w-full rounded-lg bg-surface border border-border px-3 py-2 text-sm" rows={4} value={description} maxLength={5000} onChange={(e) => setDescription(e.target.value)} placeholder="Description" aria-label="Description" />
            <div className="flex gap-2">
              <Button variant="primary" disabled={!title.trim() || update.isPending}>Save</Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </form>
        ) : (
          <>
            <h1 className="text-xl font-semibold break-words">{v.title}</h1>
            <div className="flex flex-wrap items-center gap-2 mt-2 text-sm text-muted">
              <Avatar name={v.owner.name} image={v.owner.image} size={24} />
              <span className="text-text">{v.owner.name}</span>
              <span>·</span>
              <span>{v.status === "live" ? `live since ${timeAgo(v.startedAt)}` : timeAgo(v.publishedAt ?? v.createdAt)}</span>
              {v.can.manage && <StatusBadge v={v} />}
              {v.source === "live" && v.status !== "live" && <Badge>recorded live</Badge>}
            </div>
            {v.description && <p className="mt-3 text-sm whitespace-pre-wrap break-words">{v.description}</p>}
          </>
        )}
      </div>

      {v.can.manage && (
        <aside className="rounded-xl border border-border bg-surface p-4 space-y-3 self-start">
          <div className="text-sm font-semibold">Owner controls</div>
          <div className="flex flex-wrap gap-2">
            {v.visibility === "private" ? (
              <Button variant="primary" disabled={update.isPending} onClick={() => update.mutate({ id: v.id, visibility: "public" })}>
                Publish
              </Button>
            ) : (
              <Button disabled={update.isPending} onClick={() => update.mutate({ id: v.id, visibility: "private" })}>
                Make private
              </Button>
            )}
            {!editing && <Button onClick={() => setEditing(true)}>Edit details</Button>}
            {v.status === "failed" && v.source === "upload" && (
              <Button disabled={retry.isPending} onClick={() => retry.mutate({ id: v.id })}>Retry processing</Button>
            )}
            {v.status !== "live" && (
              <Button variant="danger" disabled={del.isPending} onClick={() => confirm("Delete this video and all its annotations? This can't be undone.") && del.mutate({ id: v.id })}>
                Delete
              </Button>
            )}
          </div>
          <p className="text-xs text-muted">
            {v.visibility === "public"
              ? "Public: in the feed. Any signed-in user can watch and annotate."
              : "Private: only you can see and annotate it."}
            {v.sizeBytes > 0 && ` Uses ${formatBytes(v.sizeBytes)} of your storage.`}
          </p>
          {v.status === "live" && (
            <p className="text-xs text-muted">
              To stop, end the stream in OBS. Stream settings are in <Link to="/studio" className="text-accent">Go live</Link>.
            </p>
          )}
          {err && <p className="text-xs text-red-300">{errorMessage(err)}</p>}
        </aside>
      )}
    </div>
  );
}
