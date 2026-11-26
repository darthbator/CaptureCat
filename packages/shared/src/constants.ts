export const GiB = 1024 ** 3;

/** Annotation text limits. */
export const ANNOTATION_BODY_MAX = 500;

/** Default annotation duration: 5 s, plus ~0.3 s per word, capped at 15 s. */
export const DEFAULT_DURATION_MS = 5_000;
export const PER_WORD_MS = 300;
export const MAX_DEFAULT_DURATION_MS = 15_000;
export const MIN_DURATION_MS = 500;
/** Hard cap on how long a single annotation can stay on screen. */
export const MAX_DURATION_MS = 10 * 60_000;

/** Storage quotas. */
export const DEFAULT_QUOTA_BYTES = 20 * GiB;
export const QUOTA_WARN_RATIO = 0.9;

/** Annotation rate limit per user. */
export const ANNOTATION_RATE_LIMIT = { max: 10, windowMs: 10_000 };

export const VIDEO_STATUSES = ["live", "processing", "ready", "failed"] as const;
export const VISIBILITIES = ["private", "public"] as const;
export const ROLES = ["user", "admin"] as const;
export const VIDEO_SOURCES = ["live", "upload"] as const;

export type VideoStatus = (typeof VIDEO_STATUSES)[number];
export type Visibility = (typeof VISIBILITIES)[number];
export type Role = (typeof ROLES)[number];
export type VideoSource = (typeof VIDEO_SOURCES)[number];
