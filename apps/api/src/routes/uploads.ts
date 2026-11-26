import path from "node:path";
import { newId, video } from "@capturecat/db";
import { canCreateMedia } from "@capturecat/shared";
import { FileStore } from "@tus/file-store";
import { Server } from "@tus/server";
import type { FastifyInstance } from "fastify";
import { paths } from "../config.js";
import { db } from "../db.js";
import { publish } from "../events.js";
import { enqueueProcessUpload } from "../queue.js";
import { checkUserStorage, recomputeUsedBytes } from "../storage.js";
import { getRequestUser, toViewer } from "../viewer.js";

const MAX_UPLOAD_BYTES = 50 * 1024 ** 3;

class HttpError extends Error {
  constructor(
    public status_code: number,
    public body: string,
  ) {
    super(body);
  }
}

function titleFromFilename(name: string | null | undefined): string {
  if (!name) return "Untitled upload";
  const base = path.basename(name).replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim();
  return base.slice(0, 200) || "Untitled upload";
}

/**
 * Resumable uploads (tus protocol), written straight to DATA_DIR/uploads.
 * Quota and free disk space are checked before the upload starts, using the declared size.
 */
export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  const datastore = new FileStore({ directory: paths.uploads });

  const tus = new Server({
    path: "/api/uploads",
    datastore,
    relativeLocation: true,
    respectForwardedHeaders: true,
    maxSize: MAX_UPLOAD_BYTES,
    async onUploadCreate(req, upload) {
      const me = await getRequestUser(req.headers);
      if (!me) throw new HttpError(401, "Sign in required");
      if (!canCreateMedia(toViewer(me))) throw new HttpError(403, "Your account is suspended.");
      if (upload.sizeIsDeferred || !upload.size) throw new HttpError(400, "Upload size must be known up front.");
      const check = await checkUserStorage(me.id, upload.size);
      if (!check.ok) throw new HttpError(413, check.message);
      return { metadata: { ...upload.metadata, ownerId: me.id } };
    },
    async onIncomingRequest(req, uploadId) {
      if (req.method === "POST" || req.method === "OPTIONS") return;
      const me = await getRequestUser(req.headers);
      if (!me) throw new HttpError(401, "Sign in required");
      const info = await datastore.getUpload(uploadId).catch(() => null);
      if (info && info.metadata?.ownerId !== me.id) throw new HttpError(403, "Not your upload");
    },
    async onUploadFinish(_req, upload) {
      const ownerId = upload.metadata?.ownerId;
      if (!ownerId) throw new HttpError(400, "Missing owner");
      const id = newId();
      const sourcePath = path.join(paths.uploads, upload.id);
      const [created] = await db
        .insert(video)
        .values({
          id,
          ownerId,
          title: titleFromFilename(upload.metadata?.filename),
          source: "upload",
          status: "processing",
          visibility: "private",
          sourcePath,
          sizeBytes: upload.size ?? 0,
          progress: 0,
        })
        .returning();
      await recomputeUsedBytes(ownerId);
      await enqueueProcessUpload({ videoId: id });
      await publish({ type: "video.updated", videoId: id, ownerId, visibility: "private" });
      return { headers: { "x-video-id": created!.id } };
    },
  });

  await app.register(async (scope) => {
    // Let tus read the raw request stream.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, _payload, done) => done(null));
    const handler = async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
      reply.hijack();
      await tus.handle(request.raw, reply.raw);
    };
    scope.all("/api/uploads", handler);
    scope.all("/api/uploads/*", handler);
  });

}
