import type { BrowseInput } from "@capturecat/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button, Empty, PageTitle, Spinner, VideoCard, VideoGrid } from "../components/ui";
import { useTRPC } from "../lib";

const field = "rounded-lg bg-surface border border-border px-3 py-2 text-sm";

export function BrowsePage() {
  const trpc = useTRPC();
  const search = useSearch({ from: "/app/browse" });
  const navigate = useNavigate();
  const [q, setQ] = useState(search.q ?? "");
  const [filters, setFilters] = useState<Omit<BrowseInput, "q" | "cursor" | "limit">>({ sort: "newest" });
  const creators = useQuery(trpc.videos.creators.queryOptions());

  // Debounce the search box into the URL.
  useEffect(() => {
    const t = setTimeout(() => void navigate({ to: "/browse", search: { q: q || undefined }, replace: true }), 300);
    return () => clearTimeout(t);
  }, [q, navigate]);

  const input = { ...filters, q: search.q || undefined, limit: 24 };
  const results = useInfiniteQuery(
    trpc.videos.browse.infiniteQueryOptions(input, { getNextPageParam: (last) => last.nextCursor ?? undefined }),
  );
  const items = results.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div>
      <PageTitle>Browse</PageTitle>
      <div className="flex flex-wrap gap-2 mb-6">
        <input className={`${field} flex-1 min-w-[220px]`} type="search" placeholder="Search titles and descriptions…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <select className={field} aria-label="Creator" value={filters.ownerId ?? ""} onChange={(e) => setFilters((f) => ({ ...f, ownerId: e.target.value || undefined }))}>
          <option value="">Anyone</option>
          {creators.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          className={field}
          aria-label="Type"
          value={filters.source ?? ""}
          onChange={(e) => setFilters((f) => ({ ...f, source: (e.target.value || undefined) as BrowseInput["source"] }))}
        >
          <option value="">Live & uploads</option>
          <option value="live">Live streams</option>
          <option value="upload">Uploads</option>
        </select>
        <select className={field} aria-label="Sort" value={filters.sort} onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value as BrowseInput["sort"] }))}>
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="most_annotated">Most annotated</option>
        </select>
        <label className={`${field} flex items-center gap-2 cursor-pointer`}>
          <input type="checkbox" checked={!!filters.hasAnnotations} onChange={(e) => setFilters((f) => ({ ...f, hasAnnotations: e.target.checked || undefined }))} />
          Has annotations
        </label>
      </div>
      {results.isPending ? (
        <Spinner />
      ) : items.length === 0 ? (
        <Empty title="No videos match">Try different words or fewer filters.</Empty>
      ) : (
        <>
          <VideoGrid>
            {items.map((v) => (
              <VideoCard key={v.id} v={v} />
            ))}
          </VideoGrid>
          {results.hasNextPage && (
            <div className="mt-6 text-center">
              <Button onClick={() => void results.fetchNextPage()} disabled={results.isFetchingNextPage}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
