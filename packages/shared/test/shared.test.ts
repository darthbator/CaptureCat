import { describe, expect, it } from "vitest";
import {
  annotationCreateInput,
  canAnnotate,
  canCreateMedia,
  canDeleteAnnotation,
  canEditAnnotation,
  canView,
  checkStorage,
  clampSpan,
  clusterPositions,
  contentRect,
  defaultDurationMs,
  elementPointToNormalized,
  formatTimecode,
  GiB,
  isActiveAt,
  liveOffsetMs,
  normalizedToElementPoint,
  quotaState,
  type Viewer,
} from "../src/index.js";

describe("contentRect (object-fit: contain)", () => {
  it("letterboxes a 16:9 video in a 4:3 element (bars top/bottom)", () => {
    const r = contentRect(800, 600, 1920, 1080);
    expect(r.width).toBe(800);
    expect(r.height).toBeCloseTo(450);
    expect(r.x).toBe(0);
    expect(r.y).toBeCloseTo(75);
  });
  it("pillarboxes a 9:16 video in a 16:9 element (bars left/right)", () => {
    const r = contentRect(1600, 900, 1080, 1920);
    expect(r.height).toBe(900);
    expect(r.width).toBeCloseTo(506.25);
    expect(r.x).toBeCloseTo((1600 - 506.25) / 2);
  });
  it("falls back to the element box when intrinsic size is unknown", () => {
    expect(contentRect(640, 360, 0, 0)).toEqual({ x: 0, y: 0, width: 640, height: 360 });
  });
});

describe("normalized coordinates", () => {
  const rect = contentRect(800, 600, 1920, 1080); // y offset 75, height 450
  it("maps the frame centre to 0.5,0.5", () => {
    expect(elementPointToNormalized(400, 300, rect)).toEqual({ x: 0.5, y: 0.5 });
  });
  it("rejects clicks on letterbox bars", () => {
    expect(elementPointToNormalized(400, 30, rect)).toBeNull();
    expect(elementPointToNormalized(400, 580, rect)).toBeNull();
  });
  it("round-trips at a different player size", () => {
    const n = elementPointToNormalized(200, 75 + 450 * 0.25, rect)!;
    const big = contentRect(1920, 1080, 1920, 1080);
    expect(normalizedToElementPoint(n.x, n.y, big)).toEqual({ left: 480, top: 270 });
  });
});

describe("timing", () => {
  it("defaults to 5 s and grows 0.3 s per word, capped at 15 s", () => {
    expect(defaultDurationMs("")).toBe(5000);
    expect(defaultDurationMs("look at this")).toBe(5900);
    expect(defaultDurationMs("word ".repeat(100))).toBe(15000);
  });
  it("clamps spans to the video and to a minimum length", () => {
    expect(clampSpan(-50, 100)).toEqual({ startMs: 0, endMs: 500 });
    expect(clampSpan(9800, 20000, 10000)).toEqual({ startMs: 9500, endMs: 10000 });
  });
  it("computes live offsets from wall clock", () => {
    const started = new Date("2026-01-01T00:00:00Z");
    expect(liveOffsetMs(new Date("2026-01-01T00:01:02.5Z"), started)).toBe(62500);
    expect(liveOffsetMs(started.getTime() - 1000, started)).toBe(0);
  });
  it("treats the active window as half-open", () => {
    const a = { startMs: 1000, endMs: 2000 };
    expect(isActiveAt(a, 1000)).toBe(true);
    expect(isActiveAt(a, 1999)).toBe(true);
    expect(isActiveAt(a, 2000)).toBe(false);
  });
  it("formats timecodes", () => {
    expect(formatTimecode(62_000)).toBe("1:02");
    expect(formatTimecode(3_723_000)).toBe("1:02:03");
  });
});

describe("clusterPositions", () => {
  it("groups markers closer than the gap", () => {
    expect(clusterPositions([100, 5, 104, 50], 8)).toEqual([
      { at: 5, members: [1] },
      { at: 50, members: [3] },
      { at: 100, members: [0, 2] },
    ]);
  });
});

describe("permissions", () => {
  const owner: Viewer = { id: "o", role: "user", suspended: false };
  const other: Viewer = { id: "b", role: "user", suspended: false };
  const admin: Viewer = { id: "a", role: "admin", suspended: false };
  const suspended: Viewer = { id: "s", role: "user", suspended: true };
  const priv = { ownerId: "o", visibility: "private" as const };
  const pub = { ownerId: "o", visibility: "public" as const };

  it("requires login for everything", () => {
    expect(canView(null, pub)).toBe(false);
    expect(canAnnotate(null, pub)).toBe(false);
  });
  it("keeps private videos owner/admin only", () => {
    expect(canView(owner, priv)).toBe(true);
    expect(canView(admin, priv)).toBe(true);
    expect(canView(other, priv)).toBe(false);
    expect(canAnnotate(other, priv)).toBe(false);
  });
  it("lets any signed-in, non-suspended user annotate public videos", () => {
    expect(canAnnotate(other, pub)).toBe(true);
    expect(canView(suspended, pub)).toBe(true);
    expect(canAnnotate(suspended, pub)).toBe(false);
    expect(canCreateMedia(suspended)).toBe(false);
  });
  it("lets authors edit, and authors/owner/admin delete", () => {
    const ann = { authorId: "b" };
    expect(canEditAnnotation(other, ann)).toBe(true);
    expect(canEditAnnotation(owner, ann)).toBe(false);
    expect(canDeleteAnnotation(owner, ann, pub)).toBe(true);
    expect(canDeleteAnnotation(admin, ann, pub)).toBe(true);
    expect(canDeleteAnnotation({ id: "x", role: "user", suspended: false }, ann, pub)).toBe(false);
  });
});

describe("quota", () => {
  it("reports ok / warn / full", () => {
    expect(quotaState(20 * GiB, 1 * GiB)).toBe("ok");
    expect(quotaState(20 * GiB, 18 * GiB)).toBe("warn");
    expect(quotaState(20 * GiB, 20 * GiB)).toBe("full");
  });
  it("refuses uploads that don't fit the quota or the disk floor", () => {
    const base = { quotaBytes: 20 * GiB, usedBytes: 19 * GiB, freeDiskBytes: 100 * GiB, minFreeDiskBytes: 5 * GiB };
    expect(checkStorage({ ...base, incomingBytes: 0.5 * GiB }).ok).toBe(true);
    expect(checkStorage({ ...base, incomingBytes: 2 * GiB })).toMatchObject({ ok: false, reason: "quota" });
    expect(checkStorage({ ...base, usedBytes: 0, incomingBytes: 2 * GiB, freeDiskBytes: 6 * GiB })).toMatchObject({
      ok: false,
      reason: "disk",
    });
  });
});

describe("schemas", () => {
  it("validates annotation input", () => {
    const ok = { videoId: "v", startMs: 1000, endMs: 6000, x: 0.5, y: 0.5, body: "hi" };
    expect(annotationCreateInput.safeParse(ok).success).toBe(true);
    expect(annotationCreateInput.safeParse({ ...ok, x: 1.5 }).success).toBe(false);
    expect(annotationCreateInput.safeParse({ ...ok, endMs: 1100 }).success).toBe(false);
    expect(annotationCreateInput.safeParse({ ...ok, body: "   " }).success).toBe(false);
  });
});
