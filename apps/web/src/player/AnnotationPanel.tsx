import { ANNOTATION_BODY_MAX, formatTimecode } from "@capturecat/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Avatar, Badge, Button } from "../components/ui";
import { errorMessage, timeAgo, useTRPC, type AnnotationDto } from "../lib";

interface Props {
  videoId: string;
  annotations: AnnotationDto[];
  activeIds: Set<string>;
  onSelect(a: AnnotationDto): void;
  canAnnotate: boolean;
}

/**
 * Comment list beside the player: a vertical column on desktop, a horizontal strip under
 * the video on narrow screens. Sorted by time; active annotations are highlighted and
 * scrolled into view. Clicking an entry seeks to its start.
 */
export function AnnotationPanel({ videoId, annotations, activeIds, onSelect, canAnnotate }: Props) {
  const listRef = useRef<HTMLOListElement>(null);
  const hovering = useRef(false);
  const firstActive = annotations.find((a) => activeIds.has(a.id))?.id;

  useEffect(() => {
    if (!firstActive || hovering.current) return;
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>(`[data-id="${firstActive}"]`);
    if (!list || !item) return;
    const horizontal = list.scrollWidth > list.clientWidth && list.scrollHeight <= list.clientHeight + 4;
    if (horizontal) list.scrollTo({ left: item.offsetLeft - list.offsetLeft - 8, behavior: "smooth" });
    else list.scrollTo({ top: item.offsetTop - list.offsetTop - 8, behavior: "smooth" });
  }, [firstActive]);

  return (
    <section aria-label="Annotations" className="flex flex-col min-h-0 lg:h-full rounded-xl border border-border bg-surface">
      <header className="flex items-center justify-between px-3 py-2 border-b border-border">
        <h2 className="text-sm font-semibold">
          Annotations <span className="text-muted font-normal">({annotations.length})</span>
        </h2>
        {canAnnotate && <span className="text-xs text-muted hidden sm:inline">Click the video to add one</span>}
      </header>
      {annotations.length === 0 ? (
        <p className="p-4 text-sm text-muted">{canAnnotate ? "No annotations yet. Click anywhere on the video to add the first." : "No annotations yet."}</p>
      ) : (
        <ol
          ref={listRef}
          onMouseEnter={() => (hovering.current = true)}
          onMouseLeave={() => (hovering.current = false)}
          className="scroll-thin flex lg:flex-col gap-2 p-2 overflow-x-auto lg:overflow-x-hidden lg:overflow-y-auto snap-x lg:snap-none min-h-0 lg:flex-1"
        >
          {annotations.map((a) => (
            <PanelItem key={a.id} a={a} videoId={videoId} active={activeIds.has(a.id)} onSelect={onSelect} />
          ))}
        </ol>
      )}
    </section>
  );
}

function PanelItem({ a, videoId, active, onSelect }: { a: AnnotationDto; videoId: string; active: boolean; onSelect(a: AnnotationDto): void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(a.body);
  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.annotations.list.queryKey({ videoId }) });
  const update = useMutation(trpc.annotations.update.mutationOptions({ onSuccess: () => (setEditing(false), invalidate()) }));
  const del = useMutation(trpc.annotations.delete.mutationOptions({ onSuccess: invalidate }));

  return (
    <li
      data-id={a.id}
      data-testid="annotation-item"
      className={`snap-start shrink-0 w-64 lg:w-auto rounded-lg border p-2.5 transition-colors ${
        active ? "border-sky-400/70 bg-sky-400/10" : "border-border bg-surface-2/60 hover:border-muted/50"
      }`}
    >
      <button type="button" className="w-full text-left" onClick={() => onSelect(a)} aria-label={`Jump to ${formatTimecode(a.startMs)}`}>
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-sky-300 tabular-nums">{formatTimecode(a.startMs)}</span>
          <Avatar name={a.author.name} image={a.author.image} size={18} />
          <span className="font-medium truncate">{a.author.name}</span>
          {a.createdDuringLive && <Badge>live</Badge>}
          <span className="ml-auto text-muted shrink-0">{timeAgo(a.createdAt)}</span>
        </div>
        {!editing && <p className="mt-1.5 text-sm whitespace-pre-wrap break-words line-clamp-4 lg:line-clamp-none">{a.body}</p>}
      </button>
      {editing && (
        <form
          className="mt-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate({ id: a.id, body });
          }}
        >
          <textarea
            className="w-full rounded-md bg-bg border border-border p-2 text-sm"
            value={body}
            maxLength={ANNOTATION_BODY_MAX}
            rows={3}
            onChange={(e) => setBody(e.target.value)}
            autoFocus
          />
          {update.error && <p className="text-xs text-red-300">{errorMessage(update.error)}</p>}
          <div className="flex gap-1.5 mt-1">
            <Button size="sm" variant="primary" disabled={!body.trim() || update.isPending}>Save</Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => (setEditing(false), setBody(a.body))}>Cancel</Button>
          </div>
        </form>
      )}
      {!editing && (a.can.edit || a.can.delete) && (
        <div className="flex gap-1 mt-1.5 -mb-1">
          {a.can.edit && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>}
          {a.can.delete && (
            <Button size="sm" variant="ghost" disabled={del.isPending} onClick={() => confirm("Delete this annotation?") && del.mutate({ id: a.id })}>
              Delete
            </Button>
          )}
          {a.editedAt && <span className="ml-auto self-center text-[11px] text-muted">edited</span>}
        </div>
      )}
    </li>
  );
}
