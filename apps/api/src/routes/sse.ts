import { canView, type ServerEvent } from "@capturecat/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { subscribe } from "../events.js";
import { getRequestUser, getVideoCached, toViewer, videoAccess } from "../viewer.js";

function openStream(reply: FastifyReply, onClose: () => void) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => {
    clearInterval(heartbeat);
    onClose();
  });
  return (e: ServerEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
}

export async function sseRoutes(app: FastifyInstance): Promise<void> {
  /** Events for one video: annotations and video status. */
  app.get<{ Params: { id: string } }>("/api/videos/:id/events", async (request, reply) => {
    const me = await getRequestUser(request.headers);
    if (!me) return reply.code(401).send({ error: "Sign in required" });
    const v = await getVideoCached(request.params.id);
    if (!v || !canView(toViewer(me), videoAccess(v))) return reply.code(404).send({ error: "Not found" });

    let unsubscribe = () => {};
    const send = openStream(reply, () => unsubscribe());
    unsubscribe = subscribe((e) => {
      if (e.videoId === v.id) send(e);
    });
  });

  /**
   * App-wide events: status/progress of the user's own videos and of public videos
   * (feed and "Live now" refresh). Payloads are ids only; clients refetch with auth.
   */
  app.get("/api/events", async (request, reply) => {
    const me = await getRequestUser(request.headers);
    if (!me) return reply.code(401).send({ error: "Sign in required" });
    let unsubscribe = () => {};
    const send = openStream(reply, () => unsubscribe());
    unsubscribe = subscribe((e) => {
      if (e.type !== "video.updated" && e.type !== "video.progress") return;
      if (e.ownerId === me.id || e.visibility === "public" || me.role === "admin") send(e);
    });
  });
}
