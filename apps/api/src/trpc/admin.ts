import { auditLog, newId, user } from "@capturecat/db";
import { ROLES } from "@capturecat/shared";
import { desc, eq, ilike, or, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db.js";
import { adminProcedure, badRequest, router } from "./trpc.js";

async function audit(actorId: string, action: string, targetId: string, data: unknown) {
  await db.insert(auditLog).values({ id: newId(16), actorId, action, targetType: "user", targetId, data });
}

export const adminRouter = router({
  users: adminProcedure.input(z.object({ q: z.string().trim().optional() })).query(async ({ input }) => {
    const where = input.q ? or(ilike(user.name, `%${input.q}%`), ilike(user.email, `%${input.q}%`)) : undefined;
    return db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        role: user.role,
        suspendedAt: user.suspendedAt,
        quotaBytes: user.quotaBytes,
        usedBytes: user.usedBytes,
        createdAt: user.createdAt,
        videoCount: dsql<number>`(select count(*)::int from "video" v where v.owner_id = "user"."id")`,
      })
      .from(user)
      .where(where)
      .orderBy(desc(user.createdAt))
      .limit(200);
  }),

  setQuota: adminProcedure
    .input(z.object({ userId: z.string(), quotaBytes: z.number().int().min(0) }))
    .mutation(async ({ ctx, input }) => {
      await db.update(user).set({ quotaBytes: input.quotaBytes }).where(eq(user.id, input.userId));
      await audit(ctx.user.id, "user.quota", input.userId, { quotaBytes: input.quotaBytes });
      return { ok: true };
    }),

  setSuspended: adminProcedure
    .input(z.object({ userId: z.string(), suspended: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.id) badRequest("You can't suspend yourself.");
      await db
        .update(user)
        .set({ suspendedAt: input.suspended ? new Date() : null })
        .where(eq(user.id, input.userId));
      await audit(ctx.user.id, input.suspended ? "user.suspend" : "user.unsuspend", input.userId, null);
      return { ok: true };
    }),

  setRole: adminProcedure
    .input(z.object({ userId: z.string(), role: z.enum(ROLES) }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.id) badRequest("You can't change your own role.");
      await db.update(user).set({ role: input.role }).where(eq(user.id, input.userId));
      await audit(ctx.user.id, "user.role", input.userId, { role: input.role });
      return { ok: true };
    }),

  auditLog: adminProcedure.query(async () => {
    return db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        actorName: user.name,
        targetId: auditLog.targetId,
        data: auditLog.data,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .leftJoin(user, eq(user.id, auditLog.actorId))
      .orderBy(desc(auditLog.createdAt))
      .limit(100);
  }),
});
