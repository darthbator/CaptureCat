import { QUEUES, type FinalizeLiveJob, type ProcessUploadJob } from "@capturecat/db";
import { PgBoss } from "pg-boss";
import { config } from "./config.js";

export const boss = new PgBoss({ connectionString: config.databaseUrl, schema: "pgboss" });

export async function startQueue(): Promise<void> {
  boss.on("error", (err) => console.error("[pg-boss]", err));
  await boss.start();
  for (const name of Object.values(QUEUES)) await boss.createQueue(name);
}

export async function enqueueProcessUpload(job: ProcessUploadJob): Promise<void> {
  await boss.send(QUEUES.processUpload, job, { retryLimit: 1, expireInSeconds: 6 * 3600 });
}

export async function enqueueFinalizeLive(job: FinalizeLiveJob): Promise<void> {
  await boss.send(QUEUES.finalizeLive, job, { retryLimit: 2, retryDelay: 15, expireInSeconds: 6 * 3600 });
}
