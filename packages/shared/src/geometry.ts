/**
 * Annotation positions are stored normalized (0..1) against the video FRAME, not the
 * <video> element. With `object-fit: contain` the frame is letterboxed inside the element,
 * so we compute the rendered content box first.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The box (relative to the element's top-left) where the video frame is actually drawn
 * for `object-fit: contain`. Returns the full element box if the intrinsic size is unknown.
 */
export function contentRect(
  elementWidth: number,
  elementHeight: number,
  videoWidth: number,
  videoHeight: number,
): Rect {
  if (elementWidth <= 0 || elementHeight <= 0 || videoWidth <= 0 || videoHeight <= 0) {
    return { x: 0, y: 0, width: Math.max(0, elementWidth), height: Math.max(0, elementHeight) };
  }
  const elementRatio = elementWidth / elementHeight;
  const videoRatio = videoWidth / videoHeight;
  if (videoRatio > elementRatio) {
    // Video is wider: bars on top and bottom.
    const height = elementWidth / videoRatio;
    return { x: 0, y: (elementHeight - height) / 2, width: elementWidth, height };
  }
  // Video is taller (or equal): bars left and right.
  const width = elementHeight * videoRatio;
  return { x: (elementWidth - width) / 2, y: 0, width, height: elementHeight };
}

/**
 * Convert a point relative to the element's top-left into normalized frame coordinates.
 * Returns null when the point falls on the letterbox bars (outside the frame).
 */
export function elementPointToNormalized(
  px: number,
  py: number,
  rect: Rect,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = (px - rect.x) / rect.width;
  const y = (py - rect.y) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: clamp01(x), y: clamp01(y) };
}

/** Convert normalized frame coordinates back to a point relative to the element. */
export function normalizedToElementPoint(x: number, y: number, rect: Rect): { left: number; top: number } {
  return { left: rect.x + clamp01(x) * rect.width, top: rect.y + clamp01(y) * rect.height };
}

export function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Group timeline markers that would overlap on screen. `positions` are pixel offsets,
 * returned clusters contain the indexes of the input positions, in input order.
 */
export function clusterPositions(positions: number[], minGapPx: number): { at: number; members: number[] }[] {
  const order = positions.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const clusters: { at: number; members: number[]; first: number }[] = [];
  for (const { p, i } of order) {
    const last = clusters[clusters.length - 1];
    if (last && p - last.first < minGapPx) {
      last.members.push(i);
    } else {
      clusters.push({ at: p, first: p, members: [i] });
    }
  }
  return clusters.map(({ at, members }) => ({ at, members: members.sort((a, b) => a - b) }));
}
