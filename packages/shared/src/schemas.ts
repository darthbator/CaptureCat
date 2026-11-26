import { z } from "zod";
import { ANNOTATION_BODY_MAX, MAX_DURATION_MS, MIN_DURATION_MS, VISIBILITIES } from "./constants.js";

const normalized = z.number().min(0).max(1);
const ms = z.number().int().min(0);

export const annotationCreateInput = z
  .object({
    videoId: z.string().min(1),
    startMs: ms,
    endMs: ms,
    x: normalized,
    y: normalized,
    body: z.string().trim().min(1).max(ANNOTATION_BODY_MAX),
  })
  .refine((a) => a.endMs - a.startMs >= MIN_DURATION_MS && a.endMs - a.startMs <= MAX_DURATION_MS, {
    message: "Invalid annotation duration",
    path: ["endMs"],
  });
export type AnnotationCreateInput = z.infer<typeof annotationCreateInput>;

export const annotationUpdateInput = z.object({
  id: z.string().min(1),
  body: z.string().trim().min(1).max(ANNOTATION_BODY_MAX).optional(),
  startMs: ms.optional(),
  endMs: ms.optional(),
  x: normalized.optional(),
  y: normalized.optional(),
});
export type AnnotationUpdateInput = z.infer<typeof annotationUpdateInput>;

export const videoUpdateInput = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(5000).optional(),
  visibility: z.enum(VISIBILITIES).optional(),
});
export type VideoUpdateInput = z.infer<typeof videoUpdateInput>;

export const browseInput = z.object({
  q: z.string().trim().max(200).optional(),
  ownerId: z.string().optional(),
  source: z.enum(["live", "upload"]).optional(),
  hasAnnotations: z.boolean().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  sort: z.enum(["newest", "oldest", "most_annotated"]).default("newest"),
  cursor: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(50).default(24),
});
export type BrowseInput = z.infer<typeof browseInput>;

/** Server-sent events on /api/videos/:id/events and /api/events. */
export type ServerEvent =
  | { type: "annotation.created" | "annotation.updated"; videoId: string; annotationId: string }
  | { type: "annotation.deleted"; videoId: string; annotationId: string }
  | { type: "video.updated"; videoId: string; ownerId: string; visibility: "private" | "public" }
  | { type: "video.progress"; videoId: string; ownerId: string; visibility: "private" | "public"; progress: number };
