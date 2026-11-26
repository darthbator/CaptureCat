import { quotaState } from "@capturecat/shared";
import { adminRouter } from "./admin.js";
import { annotationsRouter } from "./annotations.js";
import { channelRouter } from "./channel.js";
import { authed, router } from "./trpc.js";
import { videosRouter } from "./videos.js";

export const appRouter = router({
  me: authed.query(({ ctx }) => ({
    ...ctx.user,
    quotaState: quotaState(ctx.user.quotaBytes, ctx.user.usedBytes),
  })),
  videos: videosRouter,
  annotations: annotationsRouter,
  channel: channelRouter,
  admin: adminRouter,
});

export type AppRouter = typeof appRouter;
