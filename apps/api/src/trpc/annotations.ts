import { annotation, newId, user, video } from "@capturecat/db";
import {
  ANNOTATION_RATE_LIMIT,
  annotationCreateInput,
  annotationUpdateInput,
  canAnnotate,
  canDeleteAnnotation,
  canEditAnnotation,
  clampSpan,
} from "@capturecat/shared";
import { and, asc, eq, isNull, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db.js";
import { publish } from "../events.js";
import { toViewer, videoAccess } from "../viewer.js";
import { loadVideoForViewer } from "./videos.js";
import { authed, badRequest, forbidden, notFound, router } from "./trpc.js";
import { TRPCError } from "@trpc/server";

/** In-memory per-user rate limit (single API process). */
const recent = new Map<string, number[]>();
function rateLimit(userId: string): void {
  const now = Date.now();
  const list = (recent.get(userId) ?? []).filter((t) => now - t < ANNOTATION_RATE_LIMIT.windowMs);
  if (list.length >= ANNOTATION_RATE_LIMIT.max) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Slow down a little." });
  }
  list.push(now);
  recent.set(userId, list);
}

const annotationCols = {
  id: annotation.id,
  videoId: annotation.videoId,
  startMs: annotation.startMs,
  endMs: annotation.endMs,
  x: annotation.x,
  y: annotation.y,
  body: annotation.body,
  createdDuringLive: annotation.createdDuringLive,
  createdAt: annotation.createdAt,
  editedAt: annotation.editedAt,
  author: { id: user.id, name: user.name, image: user.image },
};

async function loadAnnotation(id: string) {
  const [row] = await db
    .select()
    .from(annotation)
    .where(and(eq(annotation.id, id), isNull(annotation.deletedAt)));
  if (!row) notFound("Annotation not found");
  return row;
}

export const annotationsRouter = router({
  list: authed.input(z.object({ videoId: z.string() })).query(async ({ ctx, input }) => {
    const { v } = await loadVideoForViewer(input.videoId, ctx.user);
    const viewer = toViewer(ctx.user);
    const rows = await db
      .select(annotationCols)
      .from(annotation)
      .innerJoin(user, eq(user.id, annotation.authorId))
      .where(and(eq(annotation.videoId, v.id), isNull(annotation.deletedAt)))
      .orderBy(asc(annotation.startMs), asc(annotation.createdAt));
    return rows.map((a) => ({
      ...a,
      createdAt: a.createdAt.toISOString(),
      editedAt: a.editedAt?.toISOString() ?? null,
      can: {
        edit: canEditAnnotation(viewer, { authorId: a.author.id }),
        delete: canDeleteAnnotation(viewer, { authorId: a.author.id }, videoAccess(v)),
      },
    }));
  }),

  create: authed.input(annotationCreateInput).mutation(async ({ ctx, input }) => {
    const { v } = await loadVideoForViewer(input.videoId, ctx.user);
    if (!canAnnotate(toViewer(ctx.user), videoAccess(v))) forbidden("You can't annotate this video.");
    if (v.status !== "live" && v.status !== "ready") badRequest("This video isn't ready for annotations yet.");
    rateLimit(ctx.user.id);
    const span = clampSpan(input.startMs, input.endMs, v.status === "ready" ? v.durationMs : null);
    const id = newId();
    await db.transaction(async (tx) => {
      await tx.insert(annotation).values({
        id,
        videoId: v.id,
        authorId: ctx.user.id,
        ...span,
        x: input.x,
        y: input.y,
        body: input.body,
        createdDuringLive: v.status === "live",
      });
      await tx
        .update(video)
        .set({ annotationCount: dsql`${video.annotationCount} + 1` })
        .where(eq(video.id, v.id));
    });
    await publish({ type: "annotation.created", videoId: v.id, annotationId: id });
    return { id, ...span };
  }),

  update: authed.input(annotationUpdateInput).mutation(async ({ ctx, input }) => {
    const a = await loadAnnotation(input.id);
    const { v } = await loadVideoForViewer(a.videoId, ctx.user);
    if (!canEditAnnotation(toViewer(ctx.user), { authorId: a.authorId })) forbidden();
    const span = clampSpan(
      input.startMs ?? a.startMs,
      input.endMs ?? a.endMs,
      v.status === "ready" ? v.durationMs : null,
    );
    await db
      .update(annotation)
      .set({
        ...span,
        body: input.body ?? a.body,
        x: input.x ?? a.x,
        y: input.y ?? a.y,
        editedAt: new Date(),
      })
      .where(eq(annotation.id, a.id));
    await publish({ type: "annotation.updated", videoId: v.id, annotationId: a.id });
    return { ok: true };
  }),

  delete: authed.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const a = await loadAnnotation(input.id);
    const { v } = await loadVideoForViewer(a.videoId, ctx.user);
    if (!canDeleteAnnotation(toViewer(ctx.user), { authorId: a.authorId }, videoAccess(v))) forbidden();
    await db.transaction(async (tx) => {
      await tx.update(annotation).set({ deletedAt: new Date() }).where(eq(annotation.id, a.id));
      await tx
        .update(video)
        .set({ annotationCount: dsql`greatest(${video.annotationCount} - 1, 0)` })
        .where(eq(video.id, v.id));
    });
    await publish({ type: "annotation.deleted", videoId: v.id, annotationId: a.id });
    return { ok: true };
  }),
});
