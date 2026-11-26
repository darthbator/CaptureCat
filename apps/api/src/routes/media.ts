import { Readable } from "node:stream";
import fastifyStatic from "@fastify/static";
import { canView } from "@capturecat/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config, paths } from "../config.js";
import { getRequestUser, getVideoCached, toViewer, videoAccess } from "../viewer.js";

/** Only plain relative file paths: no "..", no backslashes, no absolute paths. */
const SAFE_PATH = /^(?!.*\.\.)[A-Za-z0-9_\-./]+$/;

export function mediamtxAuthHeader(): string {
  return `Basic ${Buffer.from(`capturecat:${config.mediamtx.secret}`).toString("base64")}`;
}

/**
 * Every media file and live playlist/segment goes through an auth check:
 * signed in AND (video is public OR requester is owner/admin).
 */
async function authorize(request: FastifyRequest<{ Params: { videoId: string; "*": string } }>, reply: FastifyReply) {
  const rest = request.params["*"];
  if (!SAFE_PATH.test(rest) || rest.startsWith("/")) {
    reply.code(400).send({ error: "Bad path" });
    return null;
  }
  const me = await getRequestUser(request.headers);
  if (!me) {
    reply.code(401).send({ error: "Sign in required" });
    return null;
  }
  const v = await getVideoCached(request.params.videoId);
  if (!v || !canView(toViewer(me), videoAccess(v))) {
    reply.code(404).send({ error: "Not found" });
    return null;
  }
  return { v, rest };
}

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  await app.register(fastifyStatic, { root: paths.media, serve: false, decorateReply: true });

  app.get<{ Params: { videoId: string; "*": string } }>("/media/:videoId/*", async (request, reply) => {
    const ok = await authorize(request, reply);
    if (!ok) return reply;
    reply.header("cache-control", ok.rest.endsWith(".m3u8") ? "private, no-cache" : "private, max-age=86400");
    return reply.sendFile(`${ok.v.id}/${ok.rest}`, paths.media);
  });

  /** Live HLS: proxied from MediaMTX (internal only), keyed by our video id. */
  app.get<{ Params: { videoId: string; "*": string } }>("/live/:videoId/*", async (request, reply) => {
    const ok = await authorize(request, reply);
    if (!ok) return reply;
    if (ok.v.status !== "live" || !ok.v.channelId) return reply.code(404).send({ error: "Not live" });
    const query = request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "";
    const upstream = `${config.mediamtx.hlsUrl}/live/${ok.v.channelId}/${ok.rest}${query}`;
    const controller = new AbortController();
    request.raw.on("close", () => controller.abort());
    let res: Response;
    try {
      res = await fetch(upstream, { headers: { authorization: mediamtxAuthHeader() }, signal: controller.signal });
    } catch {
      return reply.code(502).send({ error: "Live server unavailable" });
    }
    reply.code(res.status);
    for (const h of ["content-type", "content-length", "cache-control"]) {
      const val = res.headers.get(h);
      if (val) reply.header(h, val);
    }
    reply.header("cache-control", "private, no-cache");
    if (!res.body) return reply.send();
    return reply.send(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream));
  });
}
