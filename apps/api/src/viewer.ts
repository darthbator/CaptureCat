import { user, video, type Video } from "@capturecat/db";
import type { Role, Viewer, Visibility } from "@capturecat/shared";
import { eq } from "drizzle-orm";
import { auth } from "./auth.js";
import { db } from "./db.js";

export interface RequestUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: Role;
  suspended: boolean;
  quotaBytes: number;
  usedBytes: number;
  impersonatedBy: string | null;
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function toHeaders(h: HeaderSource): Headers {
  if (h instanceof Headers) return h;
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => out.append(k, x));
    else out.set(k, v);
  }
  return out;
}

/** Resolve the signed-in user from request headers (cookie). Always re-reads the user row. */
export async function getRequestUser(headers: HeaderSource): Promise<RequestUser | null> {
  const result = await auth.api.getSession({ headers: toHeaders(headers) });
  if (!result) return null;
  const [u] = await db.select().from(user).where(eq(user.id, result.user.id));
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    image: u.image,
    role: u.role === "admin" ? "admin" : "user",
    suspended: u.suspendedAt != null,
    quotaBytes: u.quotaBytes,
    usedBytes: u.usedBytes,
    impersonatedBy: (result.session as { impersonatedBy?: string | null }).impersonatedBy ?? null,
  };
}

export function toViewer(u: RequestUser | null): Viewer | null {
  return u ? { id: u.id, role: u.role, suspended: u.suspended } : null;
}

export function videoAccess(v: Pick<Video, "ownerId" | "visibility">) {
  return { ownerId: v.ownerId, visibility: (v.visibility === "public" ? "public" : "private") as Visibility };
}

/** Small TTL cache for media auth checks (every HLS segment request hits this). */
const cache = new Map<string, { at: number; v: Video | null }>();
const TTL_MS = 5_000;

export async function getVideoCached(id: string): Promise<Video | null> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  const [v] = await db.select().from(video).where(eq(video.id, id));
  cache.set(id, { at: Date.now(), v: v ?? null });
  if (cache.size > 5000) cache.clear();
  return v ?? null;
}

export function invalidateVideo(id: string): void {
  cache.delete(id);
}
