/** Scrub-thumbnail cues from the worker's thumbs.vtt (sprite.jpg#xywh=x,y,w,h). */
export interface ThumbCue {
  startMs: number;
  endMs: number;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function parseTime(t: string): number {
  const [hms, ms = "0"] = t.trim().split(".");
  const parts = hms!.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return ((parts[0]! * 60 + parts[1]!) * 60 + parts[2]!) * 1000 + Number(ms.padEnd(3, "0").slice(0, 3));
}

export async function loadThumbs(vttUrl: string): Promise<ThumbCue[]> {
  const res = await fetch(vttUrl, { credentials: "same-origin" });
  if (!res.ok) return [];
  const base = vttUrl.slice(0, vttUrl.lastIndexOf("/") + 1);
  const lines = (await res.text()).split(/\r?\n/);
  const cues: ThumbCue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\S+)\s+-->\s+(\S+)/.exec(lines[i]!);
    if (!m) continue;
    const target = lines[i + 1] ?? "";
    const t = /^([^#]+)#xywh=(\d+),(\d+),(\d+),(\d+)/.exec(target);
    if (!t) continue;
    cues.push({
      startMs: parseTime(m[1]!),
      endMs: parseTime(m[2]!),
      url: base + t[1],
      x: Number(t[2]),
      y: Number(t[3]),
      w: Number(t[4]),
      h: Number(t[5]),
    });
  }
  return cues;
}

export function cueAt(cues: ThumbCue[], ms: number): ThumbCue | undefined {
  return cues.find((c) => ms >= c.startMs && ms < c.endMs) ?? cues[cues.length - 1];
}
