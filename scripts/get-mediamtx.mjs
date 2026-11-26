#!/usr/bin/env node
/** Download the pinned MediaMTX release into tools/mediamtx/ (no system install). */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "v1.21.4";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "tools", "mediamtx");
const platform = { win32: "windows", linux: "linux", darwin: "darwin" }[process.platform];
const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
if (!platform || !arch) throw new Error(`Unsupported platform ${process.platform}/${process.arch}`);
const ext = platform === "windows" ? "zip" : "tar.gz";
const url = `https://github.com/bluenviron/mediamtx/releases/download/${VERSION}/mediamtx_${VERSION}_${platform}_${arch}.${ext}`;

mkdirSync(dir, { recursive: true });
const archive = path.join(dir, `mediamtx.${ext}`);
console.log(`Downloading ${url}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`Download failed: ${res.status}`);
writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
// Windows 10+ and Linux/macOS all ship bsdtar/tar, which handles both zip and tar.gz.
execFileSync("tar", ["-xf", archive, "-C", dir], { stdio: "inherit" });
rmSync(archive);
console.log(`MediaMTX ${VERSION} installed in ${dir}`);
