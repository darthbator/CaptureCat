# CLAUDE.md — Capture Cat

## What this is
Self-hosted web app: live streaming (OBS → server) and uploaded recordings, stored on the
server's disk. Users annotate videos with a pin at a point on the frame and a time span,
including while a stream is still live. Published videos appear in a feed and browse view
for signed-in users; any signed-in user can annotate them. Login is required for everything.
Full design and rationale: `docs/ARCHITECTURE.md` (§9 = as-built differences + what's
unverified). Update it whenever a decision changes.

## Status
Phases 0–4 are built and tested locally (unit, API smoke, Playwright E2E), and the Docker
stack has been deployed and tested on a LAN server. Not yet verified: a real domain
(CADDY_MODE=public), real OAuth providers, Safari/iOS, OBS itself. Open questions: docs/ARCHITECTURE.md §8.
Don't commit unless the user asks.

## Commands (run from repo root)
pnpm isn't installed globally: use `npx pnpm@10.34.9 <cmd>` (or install pnpm).
- `npx pnpm@10.34.9 install`; first time also `node scripts/get-mediamtx.mjs` (MediaMTX → tools/mediamtx/)
- `npx pnpm@10.34.9 dev` = `node scripts/dev.mjs`: embedded Postgres (:5433, data .dev/pg),
  MediaMTX, API (:4000, DEV_LOGIN=1), worker, Vite (http://localhost:5173). Ctrl+C stops all.
- `npx pnpm@10.34.9 seed`: idempotent dev users (needs Postgres running; `dev` starts it)
- `npx pnpm@10.34.9 typecheck` · `npx pnpm@10.34.9 test` (19 unit tests, packages/shared)
- `npx pnpm@10.34.9 test:smoke`: 50 API checks against the running dev stack (apps/api/test/smoke.ts)
- `npx pnpm@10.34.9 test:e2e`: Playwright (apps/web/e2e). Browsers live in node_modules:
  install with `PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium` in apps/web.
- `npx pnpm@10.34.9 db:generate`: new Drizzle migration after editing packages/db/src/schema.ts
  (migrations apply automatically when the API starts).
- `npx pnpm@10.34.9 build`: production SPA build (apps/web/dist)
- Production: `docker compose -f infra/docker-compose.yml --env-file infra/.env up -d --build`
  (see infra/.env.example); backups: `sh scripts/backup.sh`.

## Deployment notes
- Deploy = push to GitHub, then on the server `git pull --ff-only && docker compose -f
  infra/docker-compose.yml --env-file infra/.env up -d --build`.
- CADDY_MODE: `public` = real domain + Let's Encrypt; `lan` = IP/local name, catch-all
  https:// with Caddy's internal CA (browsers send no SNI for IPs, so the catch-all is required).
- Video data (/data in api, worker, mediamtx) is the `media` volume, bind-mounted to MEDIA_DIR
  on the host (default /srv/capturecat/media, must exist, owned by uid 1000). Docker never
  updates an existing volume's options: changing MEDIA_DIR needs `down` + `docker volume rm
  capturecat_media` (copy the data first). Postgres/Caddy data stay in named volumes.
- A service whose mounted config changed (e.g. mediamtx.yml) needs `docker compose restart <svc>`.
- Never print infra/.env values; `docker compose config` output includes DATABASE_URL with the
  Postgres password. Keep host names/IPs out of the repo.

## Layout
- packages/shared: constants, geometry (letterbox math, marker clustering), timing (default
  duration, live offsets), permissions, quota, zod schemas, SSE event types. Unit-tested.
- packages/db: Drizzle schema (Better Auth tables + channel/video/annotation/audit_log),
  migrations in packages/db/drizzle, `newId()`, queue names, dev-postgres.ts.
- apps/api/src: index.ts (startup, Origin check), auth.ts (Better Auth + dev-login plugin),
  trpc/ (videos, annotations, channel, admin), routes/ (auth, dev, uploads [tus], media
  [auth-checked /media + /live proxy], sse, mediamtx [auth hook]), live/monitor.ts (polls
  MediaMTX: stream start/stop, quota kick), storage.ts, viewer.ts, seed.ts.
- apps/worker/src: index.ts (process-upload, finalize-live, packaging lock), ffmpeg.ts
  (probe/validate/HLS/poster/sprite), cleanup.ts (hourly).
- apps/web/src: player/ (Player, useMediaClock, Timeline, AnnotationPanel, thumbs), pages/,
  components/ (AppShell, ui), lib.ts (tRPC + auth clients), router.tsx.
- infra/: Dockerfile, docker-compose.yml, Caddyfile, mediamtx.yml (prod), mediamtx.dev.yml,
  docker-compose.mock-oidc.yml, .env.example.

## Stack
- TypeScript everywhere (TS 7), Node 22+, pnpm workspaces; packages are consumed as TS source.
- web: React 19 + Vite 8, TanStack Router (code-based routes) + Query, tRPC v11
  (`@trpc/tanstack-react-query`, `useTRPC()`), Tailwind v4 (hand-written components, no
  shadcn CLI), hls.js with custom controls, Uppy + tus.
- api: Fastify 5 + tRPC, Better Auth 1.7 (drizzle adapter, admin plugin), @tus/server,
  pg-boss 12 (sender), SSE. worker: pg-boss consumer, ffmpeg via npm binaries in dev.
- PostgreSQL 18 (embedded-postgres in dev, postgres:18 in Docker), Drizzle ORM 0.45.
- MediaMTX 1.21.4 for RTMP/SRT/WHIP ingest, LL-HLS, recording.

## Authentication
- Social OAuth only (Google, GitHub, Twitch, Discord, enabled by env vars) via Better Auth.
  No passwords. Do not add email/password login.
- Server-side sessions in Postgres; httpOnly + SameSite=Lax cookie (Secure in prod); single
  origin (Vite proxy in dev, Caddy in prod). Non-GET requests outside /api/auth, /api/mediamtx,
  /api/dev must send `Origin` = BASE_URL origin (index.ts). No tokens in localStorage.
- Login required everywhere: only /login, /dev/login, /api/public-config and OAuth routes work
  without a session. A 401 from any query redirects the SPA to /login.
- Roles: `user` (default: stream, upload, publish, annotate, within quota) and `admin`
  (quotas, suspension, roles, moderation, impersonation). `user.suspended_at` blocks
  streaming/uploading/annotating but not viewing.
- Stream keys: one channel per user (`channel.id` = public channelId), key stored as sha256,
  shown once on /studio. OBS: server `rtmp://<host>:1935/live`, key `<channelId>?key=<secret>`.
- Production needs a real domain + HTTPS (OAuth providers reject bare-IP redirect URIs).

### Dev / debug login
- `/dev/login` → `POST /api/dev/login { userId }` creates a real Better Auth session via a
  plugin endpoint (its direct `/api/auth/dev/*` route is blocked). `GET/POST /api/dev/users`
  lists/creates users. Only registered when DEV_LOGIN=1 and NODE_ENV != production; loopback
  connections only; SPA shows a banner. The API refuses to start with DEV_LOGIN=1 in production.
- Seeded (fixed ids): `dev-admin`, `dev-alice` (channel `alice`), `dev-bob` (channel `bob`),
  `dev-quota-full` (quota 0). Alice/Bob stream key `dev`:
  `ffmpeg -re -stream_loop -1 -i sample.mp4 -c copy -f flv "rtmp://127.0.0.1:1935/live/alice?key=dev"`
  (ffmpeg binary: `node -p "require('ffmpeg-static')"` from apps/api).
- Mock OIDC: `infra/docker-compose.mock-oidc.yml` + `MOCK_OIDC_DISCOVERY_URL` (needs Docker).
- Real OAuth locally: separate dev OAuth apps, callback
  `http://localhost:5173/api/auth/callback/<provider>`. Never put production secrets in dev env.
- Production debugging: admin impersonation (Better Auth admin plugin, 30 min, audit-logged,
  banner). No backdoors.

## Media pipeline rules
- Live recordings and uploads produce the same Video record and the same HLS (fMP4) output
  in DATA_DIR/media/<videoId>/ (hls/index.m3u8, poster.jpg, sprite.jpg, thumbs.vtt).
  The player must not care where a video came from.
- status: live | processing | ready | failed. visibility: private | public (no unlisted).
- No GPU: remux with `-c copy` when H.264 (yuv420p) + AAC; otherwise libx264 veryfast.
  One packaging job at a time (lock across both queues). Single quality level.
- Originals (tus uploads, raw recordings) are deleted after successful processing; kept on
  failure until retry/delete. cleanup.ts removes abandoned files hourly.
- Quotas: user.quota_bytes (default 20 GB via DEFAULT_QUOTA_GB) vs used_bytes (sum of
  video.size_bytes, recomputed after changes) + MIN_FREE_DISK_GB server floor. tus refuses
  at creation if Upload-Length won't fit; publish refused at quota; monitor kicks a stream
  at 100% (via MediaMTX API) and finalizes what was recorded.
- Run ffmpeg with `spawn` and an argument array, never a shell string. Inputs use
  `-protocol_whitelist file` and a forced demuxer from the probed, whitelisted format;
  playlist/concat uploads are rejected. In Docker the worker has no internet access.
- The API serves /media/<videoId>/* and proxies /live/<videoId>/* (MediaMTX HLS) after
  checking: signed in AND (public OR owner OR admin). Never put media in a public static root.
  MediaMTX HLS + API listen on internal addresses only; the hook URL carries ?secret=.
- Recording filenames are `%s-%f` (unix s + µs) under DATA_DIR/recordings/live/<channelId>/.
- Live start/stop is detected by polling MediaMTX `/v3/paths/list` every 2 s (live/monitor.ts).

## Annotation rules
- Times are integer ms offsets from video.started_at (first frame; uploads start at 0).
  finalize-live re-bases started_at to the first recording segment and shifts annotations.
- Live: `start_ms = hls.playingDate − started_at` (PROGRAM-DATE-TIME = server clock; Safari
  fallback `video.getStartDate()`). Clicking a live stream does NOT pause it.
- x, y normalized 0..1 against the rendered content box (object-fit: contain letterboxing);
  clicks on the bars are ignored. Never store element pixels.
- Default duration: 5 s + 0.3 s/word, capped 15 s (until the user extends it: +2s/+5s,
  hold-to-extend, or dragging the green handle on the timeline). Max 10 min.
- Private: owner/admin only. Public: any signed-in, non-suspended user; authors edit/delete
  their own; video owner and admins delete any. 10 annotations per 10 s per user.
- Panel: vertical column on desktop (absolute-positioned to match the player height),
  horizontal strip under the video on mobile; clicking seeks to start_ms and pauses.
- Annotation text is plain text. Never render it as HTML.
- Player: fullscreen the wrapper, not <video>; `playsInline`; SSE /api/videos/:id/events.

## Dev environment gotchas (Windows)
- Windows 11; repo at W:\Projects\CaptureCat; PowerShell and Git Bash both available.
- No Docker, global pnpm, ffmpeg or Postgres installed: everything comes from npm or tools/.
- Killing a background process doesn't kill its children on Windows. If ports 5433/4000/5173
  stay busy, find node processes whose command line contains `CaptureCat` and stop them, then
  `pg_ctl stop -D .dev/pg` (pg_ctl is under node_modules/.pnpm/@embedded-postgres+windows-x64*/…/native/bin).
- tsx `-e` can't use top-level await; write a temp .ts file instead.
- Library versions are newer than older docs: check the installed .d.ts files before using
  an API (Better Auth, pg-boss 12, tus 2, tRPC 11, zod 4).

## Conventions
- Shared types and zod schemas go in packages/shared. Don't duplicate them across web and api.
- Schema changes only via Drizzle migrations.
- Keep this file and docs/ARCHITECTURE.md up to date when decisions change.
