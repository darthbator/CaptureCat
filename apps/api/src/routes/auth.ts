import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { auth, enabledProviders } from "../auth.js";
import { config } from "../config.js";

/** Convert a Fastify request into a Fetch Request for Better Auth. */
export function toFetchRequest(request: FastifyRequest): Request {
  const url = new URL(request.url, config.baseUrl);
  const headers = new Headers();
  for (const [k, v] of Object.entries(request.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else headers.set(k, String(v));
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== undefined;
  return new Request(url, {
    method: request.method,
    headers,
    body: hasBody ? (typeof request.body === "string" ? request.body : JSON.stringify(request.body)) : undefined,
  });
}

/** Copy a Fetch Response (including multiple Set-Cookie headers) onto a Fastify reply. */
export async function sendFetchResponse(reply: FastifyReply, response: Response): Promise<FastifyReply> {
  reply.status(response.status);
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") reply.header(key, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) reply.header("set-cookie", cookies);
  return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (request, reply) => {
      // The dev-login endpoint is only reachable through /api/dev/login (loopback-guarded).
      if (request.url.startsWith("/api/auth/dev/")) return reply.code(404).send({ error: "Not found" });
      return sendFetchResponse(reply, await auth.handler(toFetchRequest(request)));
    },
  });

  /** Unauthenticated: what the login page needs to render. */
  app.get("/api/public-config", async () => ({
    providers: enabledProviders,
    devLogin: config.devLogin,
  }));
}
