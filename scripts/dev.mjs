#!/usr/bin/env node
/**
 * `pnpm dev`: run the whole stack locally without Docker or system installs.
 *   postgres  embedded-postgres (npm binaries), data in .dev/pg, port 5433
 *   mediamtx  tools/mediamtx/mediamtx(.exe) with infra/mediamtx.dev.yml
 *   api       Fastify on 127.0.0.1:4000 (DEV_LOGIN=1)
 *   worker    pg-boss consumer, ffmpeg from npm
 *   web       Vite on http://localhost:5173 (proxies /api, /media, /live to the API)
 * Postgres starts first; everything else starts once it's ready. Ctrl+C stops all.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const req = (from) => createRequire(path.join(root, from, "package.json"));
const tsxCli = req("apps/api").resolve("tsx/cli");
const viteCli = path.join(path.dirname(req("apps/web").resolve("vite/package.json")), "bin", "vite.js");
const mediamtxBin = path.join(root, "tools", "mediamtx", process.platform === "win32" ? "mediamtx.exe" : "mediamtx");

const colors = { postgres: 34, mediamtx: 35, api: 32, worker: 33, web: 36 };
const children = [];

function start(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd ?? root,
    env: { ...process.env, ...opts.env },
    stdio: [opts.stdinPipe ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const prefix = `\x1b[${colors[name]}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = "";
    stream.setEncoding("utf8").on("data", (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        out.write(prefix + line + "\n");
        opts.onLine?.(line);
      }
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    process.stdout.write(`${prefix}exited (${code})\n`);
    if (!stopping && opts.critical) shutdown(1);
  });
  child.capturecatName = name;
  children.push(child);
  return child;
}

let stopping = false;
/** Kill a process and all its descendants (tsx watch spawns a child node process). */
function killTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  const pg = children.find((c) => c.capturecatName === "postgres");
  for (const c of children) if (c !== pg) killTree(c);
  // Postgres stops cleanly when its stdin closes (works on Windows too).
  pg?.stdin?.end();
  const done = () => process.exit(code);
  if (pg && pg.exitCode === null) {
    pg.on("exit", done);
    setTimeout(() => (killTree(pg), done()), 8000).unref();
  } else done();
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const devEnv = { NODE_ENV: "development", DEV_LOGIN: "1", BASE_URL: "http://localhost:5173" };

await new Promise((resolve) => {
  start("postgres", process.execPath, [tsxCli, "packages/db/src/dev-postgres.ts"], {
    critical: true,
    stdinPipe: true,
    onLine: (line) => line.includes("ready on") && resolve(),
  });
});

if (existsSync(mediamtxBin)) {
  start("mediamtx", mediamtxBin, [path.join(root, "infra", "mediamtx.dev.yml")]);
} else {
  console.warn(`[dev] MediaMTX not found at ${mediamtxBin}; live streaming disabled. Run: node scripts/get-mediamtx.mjs`);
}
start("api", process.execPath, [tsxCli, "watch", "--clear-screen=false", "src/index.ts"], {
  cwd: path.join(root, "apps", "api"),
  env: devEnv,
});
start("worker", process.execPath, [tsxCli, "watch", "--clear-screen=false", "src/index.ts"], {
  cwd: path.join(root, "apps", "worker"),
  env: devEnv,
});
start("web", process.execPath, [viteCli], { cwd: path.join(root, "apps", "web") });
