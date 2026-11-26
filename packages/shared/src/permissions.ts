import type { Role, Visibility } from "./constants.js";

export interface Viewer {
  id: string;
  role: Role;
  suspended: boolean;
}

export interface VideoAccess {
  ownerId: string;
  visibility: Visibility;
}

export interface AnnotationAccess {
  authorId: string;
}

const isAdmin = (v: Viewer | null): boolean => v?.role === "admin";

/** Login is required for everything. Private: owner/admin only. Public: any signed-in user. */
export function canView(viewer: Viewer | null, video: VideoAccess): boolean {
  if (!viewer) return false;
  if (isAdmin(viewer) || viewer.id === video.ownerId) return true;
  return video.visibility === "public";
}

/** Same audience as viewing, but suspended users can't annotate. */
export function canAnnotate(viewer: Viewer | null, video: VideoAccess): boolean {
  if (!viewer || viewer.suspended) return false;
  return canView(viewer, video);
}

/** Video settings (title, visibility, delete): owner or admin. */
export function canManageVideo(viewer: Viewer | null, video: VideoAccess): boolean {
  if (!viewer) return false;
  return isAdmin(viewer) || viewer.id === video.ownerId;
}

/** Authors edit their own annotations (unless suspended). */
export function canEditAnnotation(viewer: Viewer | null, annotation: AnnotationAccess): boolean {
  if (!viewer || viewer.suspended) return false;
  return viewer.id === annotation.authorId;
}

/** Authors, the video owner, and admins can delete an annotation. */
export function canDeleteAnnotation(viewer: Viewer | null, annotation: AnnotationAccess, video: VideoAccess): boolean {
  if (!viewer) return false;
  if (isAdmin(viewer) || viewer.id === video.ownerId) return true;
  return !viewer.suspended && viewer.id === annotation.authorId;
}

/** Streaming and uploading: any signed-in, non-suspended user (quota is checked separately). */
export function canCreateMedia(viewer: Viewer | null): boolean {
  return !!viewer && !viewer.suspended;
}
