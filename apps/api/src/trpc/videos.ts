import { user, video, type Video } from "@capturecat/db";
import { browseInput, canManageVideo, canView, videoUpdateInput } from "@capturecat/shared";
import { and, asc, desc, eq, gt, gte, lte, sql as dsql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db.js";
import { publish } from "../events.js";
import { enqueueProcessUpload } from "../queue.js";
import { deleteVideoFiles, recomputeUsedBytes } from "../storage.js";
import { invalidateVideo, toViewer, videoAccess, type RequestUser } from "../viewer.js";
import { toVideoDto, type OwnerDto } from "./dto.js";
import { authed, badRequest, forbidden, notFound, router } from "./trpc.js";

const ownerCols = { id: user.id, name: user.name, image: user.image };

async function withOwners(rows: { v: Video; o: OwnerDto }[], me: RequestUser) {
  return rows.map(({ v, o }) => toVideoDto(v, o, me));
}

export async function loadVideoForViewer(id: string, me: RequestUser) {
  const [row] = await db
    .select({ v: video, o: ownerCols })
    .from(video)
    .innerJoin(user, eq(user.id, video.ownerId))
    .where(eq(video.id, id));
  if (!row || !canView(toViewer(me), videoAccess(row.v))) notFound("Video not found");
  return row;
}

export async function emitVideoUpdated(v: Pick<Video, "id" | "ownerId" | "visibility">) {
  invalidateVideo(v.id);
  await publish({ type: "video.updated", videoId: v.id, ownerId: v.ownerId, visibility: v.visibility as "private" | "public" });
}

const PAGE = 24;

export const videosRouter = router({
  /** The signed-in user's own videos, all statuses, newest first. */
  library: authed.query(async ({ ctx }) => {
    const rows = await db
      .select({ v: video, o: ownerCols })
      .from(video)
      .innerJoin(user, eq(user.id, video.ownerId))
      .where(eq(video.ownerId, ctx.user.id))
      .orderBy(desc(video.createdAt));
    return withOwners(rows, ctx.user);
  }),

  get: authed.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const { v, o } = await loadVideoForViewer(input.id, ctx.user);
    return toVideoDto(v, o, ctx.user);
  }),

  update: authed.input(videoUpdateInput).mutation(async ({ ctx, input }) => {
    const { v } = await loadVideoForViewer(input.id, ctx.user);
    if (!canManageVideo(toViewer(ctx.user), videoAccess(v))) forbidden();
    const patch: Partial<Video> = { updatedAt: new Date() };
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.visibility !== undefined && input.visibility !== v.visibility) {
      patch.visibility = input.visibility;
      if (input.visibility === "public") patch.publishedAt = new Date();
    }
    const [updated] = await db.update(video).set(patch).where(eq(video.id, v.id)).returning();
    await emitVideoUpdated(updated!);
    return { ok: true };
  }),

  delete: authed.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const { v } = await loadVideoForViewer(input.id, ctx.user);
    if (!canManageVideo(toViewer(ctx.user), videoAccess(v))) forbidden();
    if (v.status === "live") badRequest("Stop the stream before deleting it.");
    await db.delete(video).where(eq(video.id, v.id));
    await deleteVideoFiles(v.id, v.sourcePath);
    await recomputeUsedBytes(v.ownerId);
    await emitVideoUpdated(v);
    return { ok: true };
  }),

  retry: authed.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const { v } = await loadVideoForViewer(input.id, ctx.user);
    if (!canManageVideo(toViewer(ctx.user), videoAccess(v))) forbidden();
    if (v.status !== "failed" || v.source !== "upload" || !v.sourcePath) badRequest("This video can't be retried.");
    await db.update(video).set({ status: "processing", error: null, progress: 0 }).where(eq(video.id, v.id));
    await enqueueProcessUpload({ videoId: v.id });
    await emitVideoUpdated(v);
    return { ok: true };
  }),

  /** Public live streams, for the "Live now" row. */
  liveNow: authed.query(async ({ ctx }) => {
    const rows = await db
      .select({ v: video, o: ownerCols })
      .from(video)
      .innerJoin(user, eq(user.id, video.ownerId))
      .where(and(eq(video.status, "live"), eq(video.visibility, "public")))
      .orderBy(desc(video.startedAt));
    return withOwners(rows, ctx.user);
  }),

  /** Published, ready videos, newest first. Cursor = offset. */
  feed: authed.input(z.object({ cursor: z.number().int().min(0).optional() })).query(async ({ ctx, input }) => {
    const offset = input.cursor ?? 0;
    const rows = await db
      .select({ v: video, o: ownerCols })
      .from(video)
      .innerJoin(user, eq(user.id, video.ownerId))
      .where(and(eq(video.status, "ready"), eq(video.visibility, "public")))
      .orderBy(desc(video.publishedAt), desc(video.id))
      .limit(PAGE + 1)
      .offset(offset);
    return {
      items: await withOwners(rows.slice(0, PAGE), ctx.user),
      nextCursor: rows.length > PAGE ? offset + PAGE : null,
    };
  }),

  browse: authed.input(browseInput).query(async ({ ctx, input }) => {
    const where: SQL[] = [eq(video.visibility, "public"), dsql`${video.status} in ('ready','live')`];
    if (input.q) {
      where.push(
        dsql`to_tsvector('simple', ${video.title} || ' ' || ${video.description}) @@ websearch_to_tsquery('simple', ${input.q})`,
      );
    }
    if (input.ownerId) where.push(eq(video.ownerId, input.ownerId));
    if (input.source) where.push(eq(video.source, input.source));
    if (input.hasAnnotations) where.push(gt(video.annotationCount, 0));
    if (input.from) where.push(gte(video.publishedAt, new Date(input.from)));
    if (input.to) where.push(lte(video.publishedAt, new Date(input.to)));
    const order =
      input.sort === "oldest"
        ? [asc(video.publishedAt), asc(video.id)]
        : input.sort === "most_annotated"
          ? [desc(video.annotationCount), desc(video.publishedAt)]
          : [desc(video.publishedAt), desc(video.id)];
    const offset = input.cursor ?? 0;
    const rows = await db
      .select({ v: video, o: ownerCols })
      .from(video)
      .innerJoin(user, eq(user.id, video.ownerId))
      .where(and(...where))
      .orderBy(...order)
      .limit(input.limit + 1)
      .offset(offset);
    return {
      items: await withOwners(rows.slice(0, input.limit), ctx.user),
      nextCursor: rows.length > input.limit ? offset + input.limit : null,
    };
  }),

  /** Users who have public videos (browse filter). */
  creators: authed.query(async () => {
    return db
      .selectDistinct({ id: user.id, name: user.name })
      .from(user)
      .innerJoin(video, eq(video.ownerId, user.id))
      .where(eq(video.visibility, "public"))
      .orderBy(asc(user.name));
  }),
});

