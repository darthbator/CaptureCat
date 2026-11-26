/**
 * Development-only PostgreSQL, run from npm binaries (embedded-postgres), so no system
 * install or Docker is needed. Data lives in <repo>/.dev/pg. Production uses the
 * postgres container from infra/docker-compose.yml instead.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const databaseDir = path.join(root, ".dev", "pg");
const port = Number(process.env.DEV_PG_PORT ?? 5433);

const pg = new EmbeddedPostgres({
  databaseDir,
  user: "capturecat",
  password: "capturecat",
  port,
  persistent: true,
  onLog: () => {},
});

const fresh = !existsSync(path.join(databaseDir, "PG_VERSION"));
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase("capturecat");
console.log(`[postgres] ready on 127.0.0.1:${port} (data: ${databaseDir})`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await pg.stop().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// On Windows a parent can't deliver SIGINT; scripts/dev.mjs closes our stdin instead.
// This also stops Postgres if the parent dies, so no orphaned postgres.exe is left behind.
if (!process.stdin.isTTY) {
  process.stdin.resume();
  process.stdin.on("end", stop);
  process.stdin.on("close", stop);
}
// Keep the process alive.
setInterval(() => {}, 1 << 30);
