import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/* ------------------------------------------------------------------ */
/* Better Auth tables (core + admin plugin fields) plus our user fields */
/* ------------------------------------------------------------------ */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  // admin plugin
  role: text("role").notNull().default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: ts("ban_expires"),
  // Capture Cat
  suspendedAt: ts("suspended_at"),
  quotaBytes: bigint("quota_bytes", { mode: "number" }).notNull().default(20 * 1024 ** 3),
  usedBytes: bigint("used_bytes", { mode: "number" }).notNull().default(0),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/* ------------------------------------------------------------------ */
/* Capture Cat                                                         */
/* ------------------------------------------------------------------ */

/** One live channel per user. `id` is the public channelId used in the RTMP path. */
export const channel = pgTable("channel", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  /** sha256 of the secret stream key; the key itself is never stored. */
  streamKeyHash: text("stream_key_hash"),
  /** Visibility applied to the next live stream. */
  liveVisibility: text("live_visibility").notNull().default("private"),
  liveTitle: text("live_title"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const video = pgTable(
  "video",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    channelId: text("channel_id"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    source: text("source").notNull(), // live | upload
    status: text("status").notNull(), // live | processing | ready | failed
    visibility: text("visibility").notNull().default("private"), // private | public
    publishedAt: ts("published_at"),
    /** Wall-clock time of the first frame (live). Annotation times are offsets from this. */
    startedAt: ts("started_at"),
    endedAt: ts("ended_at"),
    durationMs: integer("duration_ms"),
    width: integer("width"),
    height: integer("height"),
    /** Bytes on disk for this video (HLS + thumbnails + any original still present). */
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    /** Original upload path while it still exists (deleted after successful processing). */
    sourcePath: text("source_path"),
    hasThumbnails: boolean("has_thumbnails").notNull().default(false),
    progress: real("progress"),
    error: text("error"),
    annotationCount: integer("annotation_count").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("video_owner_idx").on(t.ownerId, t.createdAt),
    index("video_feed_idx").on(t.visibility, t.status, t.publishedAt),
    index("video_search_idx").using(
      "gin",
      sql`to_tsvector('simple', ${t.title} || ' ' || ${t.description})`,
    ),
  ],
);

export const annotation = pgTable(
  "annotation",
  {
    id: text("id").primaryKey(),
    videoId: text("video_id")
      .notNull()
      .references(() => video.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Offsets in ms from the video's first frame (video.startedAt for live). */
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    /** Normalized 0..1 against the video frame. */
    x: real("x").notNull(),
    y: real("y").notNull(),
    body: text("body").notNull(),
    createdDuringLive: boolean("created_during_live").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
    editedAt: ts("edited_at"),
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("annotation_video_start_idx").on(t.videoId, t.startMs)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    data: jsonb("data"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("audit_created_idx").on(t.createdAt)],
);

export const authTables = { user, session, account, verification };

export type User = typeof user.$inferSelect;
export type Video = typeof video.$inferSelect;
export type Annotation = typeof annotation.$inferSelect;
export type Channel = typeof channel.$inferSelect;

