import { QUOTA_WARN_RATIO } from "./constants.js";

export type QuotaState = "ok" | "warn" | "full";

export function remainingBytes(quotaBytes: number, usedBytes: number): number {
  return Math.max(0, quotaBytes - usedBytes);
}

export function quotaState(quotaBytes: number, usedBytes: number): QuotaState {
  if (usedBytes >= quotaBytes) return "full";
  if (usedBytes >= quotaBytes * QUOTA_WARN_RATIO) return "warn";
  return "ok";
}

export type StorageCheck =
  | { ok: true }
  | { ok: false; reason: "quota" | "disk"; message: string };

/**
 * Can `incomingBytes` more be stored for this user? Also enforces a server-wide floor of
 * free disk space so many users together can't fill the disk.
 */
export function checkStorage(opts: {
  quotaBytes: number;
  usedBytes: number;
  incomingBytes: number;
  freeDiskBytes: number;
  minFreeDiskBytes: number;
}): StorageCheck {
  if (opts.usedBytes + opts.incomingBytes > opts.quotaBytes) {
    return {
      ok: false,
      reason: "quota",
      message: `Not enough storage quota: ${formatBytes(remainingBytes(opts.quotaBytes, opts.usedBytes))} left.`,
    };
  }
  if (opts.freeDiskBytes - opts.incomingBytes < opts.minFreeDiskBytes) {
    return { ok: false, reason: "disk", message: "The server is low on disk space. Try again later." };
  }
  return { ok: true };
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = Math.max(0, bytes);
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}
