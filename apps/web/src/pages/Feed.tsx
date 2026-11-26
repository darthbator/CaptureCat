import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button, Empty, PageTitle, Spinner, VideoCard, VideoGrid } from "../components/ui";
import { useTRPC } from "../lib";

export function FeedPage() {
  const trpc = useTRPC();
  const live = useQuery(trpc.videos.liveNow.queryOptions());
  const feed = useInfiniteQuery(
    trpc.videos.feed.infiniteQueryOptions({}, { getNextPageParam: (last) => last.nextCursor ?? undefined }),
  );
  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-8">
      {live.data && live.data.length > 0 && (
        <section>
          <h2 className="flex items-center gap-2 text-lg font-semibold mb-3">
            <span className="h-2.5 w-2.5 rounded-full bg-live animate-pulse" /> Live now
          </h2>
          <div className="flex gap-4 overflow-x-auto scroll-thin pb-2 snap-x">
            {live.data.map((v) => (
              <div key={v.id} className="w-72 shrink-0 snap-start">
                <VideoCard v={v} />
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <PageTitle actions={<Link to="/browse" className="text-sm text-accent hover:underline">Search & filter →</Link>}>Feed</PageTitle>
        {feed.isPending ? (
          <Spinner />
        ) : items.length === 0 ? (
          <Empty title="Nothing published yet">
            Upload a video or go live from your <Link to="/library" className="text-accent">Library</Link>, then make it public.
          </Empty>
        ) : (
          <>
            <VideoGrid>
              {items.map((v) => (
                <VideoCard key={v.id} v={v} />
              ))}
            </VideoGrid>
            {feed.hasNextPage && (
              <div className="mt-6 text-center">
                <Button onClick={() => void feed.fetchNextPage()} disabled={feed.isFetchingNextPage}>
                  {feed.isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
