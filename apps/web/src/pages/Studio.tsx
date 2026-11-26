import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Badge, Button, PageTitle, QuotaBar, Spinner } from "../components/ui";
import { errorMessage, useTRPC } from "../lib";

function Copyable({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [shown, setShown] = useState(!secret);
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="text-xs text-muted mb-1">{label}</div>
      <div className="flex gap-2">
        <code className="flex-1 min-w-0 truncate rounded-lg bg-bg border border-border px-3 py-2 text-sm">{shown ? value : "•".repeat(24)}</code>
        {secret && <Button size="sm" variant="ghost" onClick={() => setShown((s) => !s)}>{shown ? "Hide" : "Show"}</Button>}
        <Button
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

export function StudioPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const ch = useQuery(trpc.channel.get.queryOptions(undefined, { refetchInterval: 4000 }));
  const [newKey, setNewKey] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const regen = useMutation(trpc.channel.regenerateKey.mutationOptions({ onSuccess: (d) => setNewKey(d.obsStreamKey) }));
  const update = useMutation(trpc.channel.update.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: trpc.channel.get.queryKey() }) }));

  useEffect(() => {
    if (ch.data) setTitle(ch.data.liveTitle);
  }, [ch.data?.liveTitle]); // eslint-disable-line react-hooks/exhaustive-deps

  if (ch.isPending) return <Spinner />;
  if (!ch.data) return null;
  const c = ch.data;

  return (
    <div className="max-w-3xl">
      <PageTitle>Go live</PageTitle>

      {c.live ? (
        <div className="mb-6 rounded-xl border border-live/50 bg-live/10 p-4 flex flex-wrap items-center gap-3">
          <Badge tone="live">● Live</Badge>
          <span className="text-sm">You're streaming now.</span>
          <Link to="/v/$videoId" params={{ videoId: c.live.videoId }} className="ml-auto rounded-lg bg-live px-3 py-1.5 text-sm font-semibold text-white">
            Open live page
          </Link>
        </div>
      ) : (
        <div className="mb-6 rounded-xl border border-border bg-surface p-4 text-sm text-muted">
          Not live. Start streaming from OBS and your stream appears here and in your library within a few seconds.
        </div>
      )}

      {c.suspended && <p className="mb-4 text-sm text-red-300">Streaming is disabled while your account is suspended.</p>}

      <section className="rounded-xl border border-border bg-surface p-5 space-y-4 mb-6">
        <h2 className="font-semibold">Stream settings (OBS)</h2>
        <ol className="text-sm text-muted list-decimal ml-5 space-y-1">
          <li>In OBS: Settings → Stream → Service: <span className="text-text">Custom…</span></li>
          <li>Paste the Server and Stream Key below.</li>
          <li>Settings → Output: encoder <span className="text-text">x264 or hardware H.264</span>, audio <span className="text-text">AAC</span>, keyframe interval <span className="text-text">2 s</span>. (This lets the recording be saved without re-encoding.)</li>
        </ol>
        <Copyable label="Server" value={c.ingest.rtmpServer} />
        {newKey ? (
          <div className="rounded-lg border border-accent/50 bg-accent/5 p-3 space-y-2">
            <Copyable label="Stream key (shown once; copy it now)" value={newKey} secret />
            <p className="text-xs text-muted">Anyone with this key can stream to your channel. Generate a new one if it leaks; the old key stops working.</p>
          </div>
        ) : (
          <div>
            <div className="text-xs text-muted mb-1">Stream key</div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">{c.hasKey ? "A stream key is set. For security it can't be shown again." : "No stream key yet."}</span>
              <Button size="sm" variant={c.hasKey ? "secondary" : "primary"} disabled={regen.isPending || c.suspended} onClick={() => (!c.hasKey || confirm("Generate a new key? The current key stops working.")) && regen.mutate()}>
                {c.hasKey ? "Generate new key" : "Generate stream key"}
              </Button>
            </div>
          </div>
        )}
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">Other ways to stream (SRT, WHIP)</summary>
          <div className="mt-2 space-y-1 text-muted">
            <p>SRT: <code className="text-text break-all">{c.ingest.srtUrl}</code></p>
            <p>The key format for any protocol is <code className="text-text">{c.ingest.streamKeyFormat}</code>.</p>
          </div>
        </details>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5 space-y-4 mb-6">
        <h2 className="font-semibold">Next stream</h2>
        <form
          className="flex flex-wrap gap-2 items-end"
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate({ liveTitle: title });
          }}
        >
          <label className="flex-1 min-w-[240px]">
            <span className="block text-xs text-muted mb-1">Title</span>
            <input className="w-full rounded-lg bg-bg border border-border px-3 py-2 text-sm" value={title} maxLength={200} placeholder="Live stream (date and time)" onChange={(e) => setTitle(e.target.value)} />
          </label>
          <Button disabled={update.isPending}>Save title</Button>
        </form>
        <fieldset>
          <legend className="text-xs text-muted mb-1.5">Visibility</legend>
          <div className="flex flex-col sm:flex-row gap-2">
            {(["private", "public"] as const).map((vis) => (
              <label key={vis} className={`flex-1 rounded-lg border p-3 cursor-pointer text-sm ${c.liveVisibility === vis ? "border-accent bg-accent/5" : "border-border"}`}>
                <input type="radio" name="vis" className="mr-2" checked={c.liveVisibility === vis} onChange={() => update.mutate({ liveVisibility: vis })} />
                <span className="font-medium capitalize">{vis}</span>
                <span className="block text-xs text-muted mt-0.5 ml-5">
                  {vis === "public" ? "Shown in “Live now”. Any signed-in user can watch and annotate live." : "Only you can watch and annotate. Publish the recording later."}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {(update.error || regen.error) && <p className="text-sm text-red-300">{errorMessage(update.error ?? regen.error)}</p>}
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <QuotaBar quotaBytes={c.storage.quotaBytes} usedBytes={c.storage.usedBytes} />
        <p className="text-xs text-muted mt-2">
          Recordings count toward your storage while you stream. You're warned at 90%; at 100% the stream is stopped and what was recorded is kept.
        </p>
      </section>
    </div>
  );
}
