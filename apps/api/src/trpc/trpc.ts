import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import { getRequestUser, type RequestUser } from "../viewer.js";

export async function createContext({ req }: CreateFastifyContextOptions) {
  const user = await getRequestUser(req.headers);
  return { user };
}
export type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape }) {
    return shape;
  },
});

export const router = t.router;

/** Login is required for everything, so there is no public procedure. */
export const authed = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in required" });
  return next({ ctx: { user: ctx.user as RequestUser } });
});

export const adminProcedure = authed.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Admins only" });
  return next();
});

export function notFound(what = "Not found"): never {
  throw new TRPCError({ code: "NOT_FOUND", message: what });
}
export function forbidden(what = "Not allowed"): never {
  throw new TRPCError({ code: "FORBIDDEN", message: what });
}
export function badRequest(what: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message: what });
}
