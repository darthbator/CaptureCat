import { EventEmitter } from "node:events";
import { EVENTS_CHANNEL } from "@capturecat/db";
import type { ServerEvent } from "@capturecat/shared";
import { sql } from "./db.js";

/**
 * All change events go through Postgres NOTIFY, so the API and the worker (separate
 * processes) share one stream. The API LISTENs and fans events out to SSE clients.
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);

export async function startEventListener(): Promise<void> {
  await sql.listen(EVENTS_CHANNEL, (payload) => {
    try {
      bus.emit("event", JSON.parse(payload) as ServerEvent);
    } catch {
      /* ignore malformed */
    }
  });
}

export async function publish(event: ServerEvent): Promise<void> {
  await sql.notify(EVENTS_CHANNEL, JSON.stringify(event));
}

export function subscribe(fn: (e: ServerEvent) => void): () => void {
  bus.on("event", fn);
  return () => bus.off("event", fn);
}
