import type { Video } from "@capturecat/db";
import { canAnnotate, canManageVideo } from "@capturecat/shared";
import { toViewer, videoAccess, type RequestUser } from "../viewer.js";

export interface OwnerDto {
  id: string;
  name: string;
  image: string | null;
}

export function videoUrls(v: Video) {
  const ready = v.status === "ready";
  return {
    hls:
      v.status === "live"
        ? `/live/${v.id}/index.m3u8`
        : ready
          ? `/media/${v.id}/hls/index.m3u8`
          : null,
    poster: ready ? `/media/${v.id}/poster.jpg` : null,
    thumbnails: ready && v.hasThumbnails ? `/media/${v.id}/thumbs.vtt` : null,
  };
}

export function toVideoDto(v: Video, owner: OwnerDto, me: RequestUser) {
  const viewer = toViewer(me);
  return {
    id: v.id,
    title: v.title,
    description: v.description,
    source: v.source as "live" | "upload",
    status: v.status as "live" | "processing" | "ready" | "failed",
    visibility: v.visibility as "private" | "public",
    publishedAt: v.publishedAt?.toISOString() ?? null,
    startedAt: v.startedAt?.toISOString() ?? null,
    endedAt: v.endedAt?.toISOString() ?? null,
    createdAt: v.createdAt.toISOString(),
    durationMs: v.durationMs,
    width: v.width,
    height: v.height,
    sizeBytes: v.sizeBytes,
    progress: v.progress,
    error: v.error,
    annotationCount: v.annotationCount,
    owner,
    urls: videoUrls(v),
    can: {
      manage: canManageVideo(viewer, videoAccess(v)),
      annotate: canAnnotate(viewer, videoAccess(v)) && (v.status === "live" || v.status === "ready"),
    },
  };
}

export type VideoDto = ReturnType<typeof toVideoDto>;
