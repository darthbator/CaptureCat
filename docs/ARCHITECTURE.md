# Capture Cat — Architecture & Stack

## Context
Capture Cat is a self-hosted web app. Users stream live (OBS or similar) or upload recordings. Everything is stored on the server's disk and played back in the browser. Users annotate videos by clicking a spot on the frame at a moment in time, including while a stream is still live. Published videos appear in a feed and browse view for signed-in users, and any signed-in user can annotate them.

Status: **built (phases 0–4)**. This document records the design; §9 lists where the implementation differs from the original plan and what is still unverified.

Decisions so far:
- **TypeScript end-to-end**
- **Social OAuth only** (no passwords)
- **Single self-hosted server**, no GPU (CPU-only encoding)
- **Live streaming is the core**; file upload is a second way in
- **Anyone who signs in can stream and upload**, limited by a per-user storage quota
- **Login required for everything**: no anonymous viewing
- **Live annotation from the start**
- **Private videos are owner-only** until published (no collaborators, no unlisted links)
- No domain yet: develop on localhost and choose a domain before going public

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Monorepo | **pnpm workspaces** | Shares types and zod schemas between web, api and worker |
| Frontend | **React 19 + Vite + TypeScript**, TanStack Router + TanStack Query, Tailwind + shadcn/ui | An SPA is enough. Everything sits behind login, so server rendering and SEO add nothing |
| Player | **hls.js + our own React controls** | We need our own timeline markers, a clickable overlay and a comment panel. Off-the-shelf player skins fight against that |
| Upload UI | **Uppy** (tus client) | Resumable uploads for multi-GB files |
| API | **Node 22 + Fastify + tRPC** (zod-validated) | tRPC gives typed app APIs. Plain Fastify routes handle OAuth, uploads, media auth, MediaMTX hooks and SSE |
| Auth | **Better Auth** (Drizzle adapter) | Framework-neutral TS library. Social providers, sessions stored in the DB, account linking |
| DB / ORM | **PostgreSQL 18 + Drizzle ORM** | Full-text search for browsing, LISTEN/NOTIFY, and it backs the job queue |
| Job queue | **pg-boss** (on Postgres) | No Redis needed on a single box |
| Media processing | **ffmpeg/ffprobe**, called with `spawn` and argument arrays | `fluent-ffmpeg` is archived. Direct calls are safer and clearer |
| Live ingest | **MediaMTX** (single Go binary) | Takes in RTMP, SRT and WHIP (OBS 30+). Puts out LL-HLS and WebRTC. Records to disk. Calls HTTP hooks for auth and stream events, and has a control API to disconnect a stream |
| Reverse proxy | **Caddy** | Automatic HTTPS once there's a domain. Serves the SPA and proxies `/api`, `/media`, `/live` to the API (which does the auth checks) |
| Deploy | **Docker Compose**: caddy, api, worker, mediamtx, postgres | One `docker compose up` on the server |

**Not used:** Next.js (large uploads and long-lived connections are awkward in its route handlers). node-media-server for RTMP ingest (less robust than MediaMTX). nginx-rtmp (unmaintained). Redis/BullMQ (one more service with no gain at this scale). Keycloak or Authentik (too heavy).

### Repo layout
```
apps/web        React SPA (login, library, watch/annotate, live, feed, browse, settings, admin)
apps/api        Fastify: tRPC routers, Better Auth, tus server, media auth, MediaMTX hooks, SSE
apps/worker     pg-boss consumers: probe, remux/transcode → HLS, thumbnails, live→VOD finalize
packages/db     Drizzle schema + migrations
packages/shared zod schemas, annotation time/coordinate math, quota math, shared types
infra/          docker-compose.yml, Caddyfile, mediamtx.yml
```

---

## 2. Authentication & access (OAuth only)

- **Providers:** Google and GitHub to start. **Twitch** and **Discord** suit a streaming audience. Better Auth links accounts that share a verified email.
- **Sessions:** server-side session rows in Postgres. An `httpOnly; Secure; SameSite=Lax` cookie on a single origin (Caddy fronts everything). No JWTs in localStorage. Mutations also check the request `Origin`.
- **Login required everywhere.** Only the login page and the OAuth callbacks work without a session. Every other route, API call, media file and live stream needs a session.
- **Roles:**
  - `user` (default for everyone who signs in): stream, upload, publish, annotate. Limited by their storage quota (§3).
  - `admin`: change quotas, suspend users, remove any video or annotation, impersonate users for debugging.
  - Suspended users can sign in but can't stream, upload or annotate.
- **Stream keys are separate from OAuth.** Each user gets a channel with a public `channelId` and a secret stream key. The key is shown once in settings, can be regenerated, and is stored only as a hash.
- **Domain:** none yet. Develop on `localhost`, where OAuth providers accept `http://localhost` callbacks. Before going public, choose a domain: Caddy gets HTTPS certificates automatically, and Google won't accept a bare IP as a login redirect.

### Debug / dev login path
There is no password login, so development needs its own way to sign in. Use three layers:

1. **`/dev/login` (daily development).** A page listing seeded users: `admin`, `alice` and `bob` (two regular users, for testing cross-user annotations), plus `quota-full` (a user at their storage limit). A "new random user" button adds more. Picking one calls `POST /api/dev/login { userId }`. That handler creates a **real Better Auth session** and sets the normal cookie, so everything after login runs exactly as in production.
   - The route is only registered when `NODE_ENV !== 'production'` **and** `DEV_LOGIN=1`. It only accepts requests from loopback addresses.
   - The API **refuses to start** if `DEV_LOGIN=1` and `NODE_ENV=production`.
   - When dev login is enabled, the SPA shows a "DEV LOGIN ENABLED" banner.
   - Alice's stream key is fixed to `dev`, so you can test live with `ffmpeg -re -stream_loop -1 -i sample.mp4 -c copy -f flv "rtmp://localhost/live/<channelId>?key=dev"`.
2. **Mock OAuth provider (tests the real login flow).** Add a mock OAuth/OIDC server container (e.g. `navikt/mock-oauth2-server`) to the dev Compose file, registered as a generic OAuth provider. It runs the full redirect, callback, account-linking and session flow with any identity you choose. Playwright E2E tests use it to cover login itself, and use `/api/dev/login` to skip login in all other tests.
3. **Real Google/GitHub on localhost (occasional check).** Register separate *dev* OAuth apps whose callback is `http://localhost:<port>/api/auth/callback/<provider>`, so production credentials never sit on a dev machine.

**Debugging in production:** no backdoor. Admins use an impersonation feature instead (Better Auth's admin plugin, or a small custom version). It is audit-logged, time-limited and shown with a banner.

## 3. Ingest: live streams and uploads → one kind of video asset

Both paths end in the same **Video** record and the same HLS output, so the player and annotations never care where a video came from.

**Live (main path)**
1. User sets up OBS: server `rtmp://host/live`, stream key `<channelId>?key=<secret>`. SRT and WHIP work the same way.
2. MediaMTX's **HTTP auth hook** calls the API for `publish`. The API hashes the key, matches it to the channel, and checks that the user isn't suspended and has quota left. If the stream starts, the API creates a `Video` with `status=live` and the visibility the user chose for the stream (private or public).
3. **`started_at`** is the wall-clock time of the stream's first frame, taken from the first HLS `PROGRAM-DATE-TIME` or recording-segment timestamp, not from when the hook fired. All annotation times are offsets from `started_at`, during the live stream and in the recording (§4).
4. **Live viewing:** MediaMTX serves LL-HLS (about 2–3 s latency) on the internal network only. The API proxies it at `/live/<videoId>/…` after checking the viewer's session and the stream's visibility. WebRTC/WHEP (under 1 s) can be an optional low-latency view for the owner.
5. **Recording:** MediaMTX is set to `record: yes` (fMP4 segments under `/data/recordings/<channelId>/`).
6. **Stream ends:** a MediaMTX hook calls the API, which queues a `finalize-live` job. The worker joins the segments (`-c copy`, no re-encode, so it's fast even without a GPU), packages them as HLS, makes thumbnails, checks that the recording's start matches `started_at` (shifting annotations once if it doesn't), and sets `status=ready`.
7. OBS guidance for users: H.264 + AAC, 2 s keyframe interval. Since there's no GPU, this matters: it keeps live → VOD as a copy with no encoding.

**Upload (second path)**
1. Uppy → **tus** (`@tus/server` + file store) writes directly to `/data/uploads`. Uploads resume after network drops. The upload is refused at the start if its declared size (`Upload-Length`) exceeds the user's remaining quota.
2. On completion, a `process-upload` job runs. `ffprobe` checks the file; we reject anything that isn't a real video container, including playlist or concat formats. If the source is H.264/AAC, we **remux** with `-c copy`.
3. Otherwise we transcode on the **CPU** (`libx264 -preset veryfast`, AAC), **one transcode job at a time** so the server stays responsive. The UI shows progress. HEVC footage from phones is the common slow case.
4. Output goes to `/data/media/<videoId>/{hls/, poster.jpg, sprite.jpg, thumbs.vtt}`.
5. **Originals are deleted after successful processing:** the uploaded file, and for live streams the raw recording segments. If processing fails, the original stays (and counts toward quota) until the user retries or deletes the video. Re-processing later (e.g. a quality ladder after a GPU upgrade) works from the processed HLS copy.

**Playback:** HLS (fMP4/CMAF) for both live and recorded video, played through hls.js (Safari plays it natively). Single quality level only: without a GPU, a 1080/720/480 ladder would cost too much CPU. Revisit if hardware changes.

**Storage quotas**
- Each user has `quota_bytes` (default **20 GB**, set in config; admins can change it per user) and `used_bytes`. `used_bytes` is the sum of each video's on-disk size: HLS output and thumbnails, plus any original still on disk (during processing, or after a failure). The 20 GB default is a placeholder until the server's disk size is known; also add a server-wide check that refuses new uploads and streams when free disk space drops below a configured floor.
- Uploads: refused at the start if they won't fit (see above).
- Live: refused at publish if the user is at quota. While streaming, the API counts recording bytes as each segment completes. At 100% it disconnects the stream through MediaMTX's control API and finalizes what was recorded. The user gets a warning at 90%.
- Deleting a video frees its space right away. The UI shows quota usage in settings and in the upload/go-live dialogs.

**Media access control:** the API serves every `/media/*` file and proxies live HLS itself. The rule: the requester must be signed in, **and** the video must be public **or** the requester must own it (or be an admin). The API answers from a short in-memory cache.

**Untrusted-media safety:** the worker runs in a container with **no network access**, writes only to its job folder, and runs ffmpeg with a demuxer whitelist. This blocks the known attacks where a crafted upload makes ffmpeg read local files or make network requests (SSRF).

## 4. Annotation model & player UX

**Data**
```
users(..., role: user|admin, suspended_at, quota_bytes, used_bytes)
videos(id, owner_id, title, description, source: live|upload,
       status: live|processing|ready|failed, visibility: private|public,
       published_at, started_at, duration_ms, size_bytes, width, height, hls_path, poster_path)
annotations(id, video_id, author_id,
            start_ms, end_ms,   -- offsets from videos.started_at (0 = first frame)
            x, y,               -- normalized 0..1 relative to the video FRAME
            created_during_live boolean,
            body, created_at, edited_at, deleted_at)
index annotations(video_id, start_ms)
```

**Placing an annotation (recorded video):** clicking the video surface pauses playback and drops a pin.
- Coordinates are normalized against the **rendered video content box**, not the `<video>` element. That accounts for letterboxing (`object-fit: contain`), so pins stay in place at any player size or in fullscreen.
- **Default timing:** `start = currentTime` at the click. `end = start + default`, where the default is 5 s and grows with comment length (about 0.3 s per word, capped near 15 s).
- **Extending the time:** drag the end handle on the timeline, use quick `+2s` / `+5s` buttons, or "hold to extend": press and hold while the video plays, and the span ends when you let go.

**Placing an annotation (live stream)**
- Clicking the surface **does not pause**: the stream keeps playing, and the pin and its start time are fixed at the moment of the click. The composer opens beside the video.
- **Live start time:** `start_ms = playingDate − started_at`. `playingDate` is hls.js's wall-clock time for the current frame, from the stream's `EXT-X-PROGRAM-DATE-TIME` tags. This uses the server's clock for both values, so viewers' local clocks and their individual latency don't matter.
- Same default duration and `+2s`/`+5s` buttons. "Hold to extend" works naturally: the span grows while held.
- When the recording is finalized, live annotations land at the same moment in the VOD, because both use offsets from `started_at`.
- **Risk to check first in phase 1:** confirm MediaMTX's HLS output includes `EXT-X-PROGRAM-DATE-TIME`. If it doesn't, the API sends the stream's start time and the client works out the offset from hls.js fragment timing.

**While watching**
- The overlay shows a pin for every annotation where `start ≤ t < end`.
- **Timeline marks:** dots at each start time. The active annotation's span is shaded. Dense areas group into a cluster. Hovering shows the comment plus a thumbnail from the sprite sheet. While live, the timeline covers the elapsed stream, and markers appear as people add them.
- **Comment panel** (decided): a **vertical** scrolling list in a column to the **right** of the video on desktop. On narrow screens it moves under the player as a horizontal strip. Sorted by time; highlights and auto-scrolls to the current annotations. Clicking one seeks to `start_ms`, pauses and flashes its pin. During a live stream, clicking an older annotation adds a "Back to live" button; the live buffer is short, so very old moments may only be reachable once the recording is finalized.
- New annotations from other users appear in real time through **SSE** (`/api/videos/:id/events`), for both live and recorded videos.
- Fullscreen applies to the **wrapper** element, not the `<video>`, so the overlay, markers and panel stay visible. Use `playsinline` so iOS doesn't switch to its native player, which would hide the overlays.

**Permissions**
- Private video or private live stream: **only the owner** (and admins) can view and annotate. No collaborators, no unlisted links.
- Public video or public live stream: any signed-in user can view and annotate. Authors can edit or delete their own annotations. The video owner and admins can remove any annotation.
- Annotation text is stored and rendered as plain text, with a length limit and a per-user rate limit.

## 5. Publishing, feed & browse
- `visibility` moves from private to public, which sets `published_at`. Going back to private removes the video from the feed but keeps its annotations.
- A live stream can be **public from the start**: it then appears in **"Live now"** at the top of the feed.
- **Feed** (signed-in users only): "Live now" row, then published videos ordered by `published_at DESC`. Pagination uses a cursor.
- **Browse:** Postgres full-text search on title and description, filters (user, date, live vs. recorded, has annotations), and a sort order.
- No Open Graph link previews: every page needs a login, so shared links only show the app's generic preview.

---

## 6. Build phases
0. **Foundation:** monorepo, Compose stack (Postgres, Caddy), Fastify + Better Auth (Google/GitHub), dev login, roles and suspension, SPA shell with every route behind login.
1. **Media pipeline:** tus upload → worker → HLS → private library → hls.js playback, with quotas enforced. Then MediaMTX with stream keys, the auth hook, live viewing, recording → VOD, and the quota disconnect. **Check for `PROGRAM-DATE-TIME` early.**
2. **Annotation player:** overlay with normalized pins, default and extendable timing, timeline markers, right-hand panel, click-to-seek, for recordings **and live** (non-pausing composer, wall-clock offsets), SSE updates.
3. **Publishing & social:** visibility, feed with "Live now", browse/search, annotations from any signed-in user, moderation, admin page (quotas, suspension).
4. **Hardening & polish:** scrub thumbnails, retention and cleanup tools, backups (`pg_dump` + `/data/media`), choosing a domain + HTTPS for public deployment.

## 7. Verification (per phase)
- **Unit (Vitest):** coordinate normalization with letterboxing, default-duration math, live offset math (`playingDate − started_at`), quota math, permission rules.
- **Integration:**
  - Stream from OBS (or a looping `ffmpeg -re ... -f flv rtmp://...`) → watch live in the browser → stop → the VOD shows up as `ready`.
  - Upload a ~2 GB file, cut the network halfway, and confirm it resumes.
  - `quota-full` can't upload or go live. A stream that hits quota mid-broadcast is disconnected, and its recording is kept.
- **E2E (Playwright):**
  - Alice streams publicly, and Bob annotates live. Alice sees Bob's marker appear. After finalize, the annotation sits at the same moment in the recording (within ±0.5 s).
  - Two sessions on a published VOD: an annotation appears in the other session in real time, and clicking it seeks to the exact time.
  - Bob gets a 403 on Alice's private video.
- **Security checks:**
  - Signed-out requests to any page, API call, `/media/*` file or live HLS URL return 401 or redirect to login.
  - `/api/dev/login` returns 404 in a production build, and the API won't start with `DEV_LOGIN=1` + `NODE_ENV=production`.
  - A wrong stream key is rejected, as is a suspended user's stream key.
  - An uploaded `.m3u8`/concat file is rejected by the worker.

## 8. Decisions & remaining questions

**Decided**
- **Comment panel:** vertical list in a right-hand column; a horizontal strip under the video on mobile.
- **Live annotation:** included from the start (phase 2), timed by wall clock.
- **Who can stream/upload:** anyone who signs in, limited by per-user quota (default 20 GB).
- **Anonymous viewing:** none. Login is required for everything.
- **Before publishing:** owner only. No collaborators and no unlisted links.
- **GPU:** none (or unknown). CPU-only, prefer remuxing, one transcode at a time, single quality level.
- **Domain:** not yet. Develop on localhost; decide before going public (needed for HTTPS and production OAuth).
- **Originals:** deleted after successful processing; kept only if processing fails.
- **Disk size:** unknown. Quota default stays 20 GB (configurable), plus a server-wide free-space floor.

**Still open (none blocking development)**
1. Server disk size: revisit the default quota once known.
2. Domain name: needed only before public deployment (phase 4).

## 9. As built: differences from the plan, and what's unverified

**Differences (deliberate simplifications):**
- **Media auth lives in the API**, not Caddy `forward_auth`. The API serves `/media/<videoId>/…` (via `@fastify/static`) and proxies `/live/<videoId>/…` to MediaMTX, checking `canView` on every request with a 5 s in-memory cache. This works identically in dev (Vite proxy) and production (Caddy proxy), with fewer moving parts.
- **Live start/stop detection polls MediaMTX's control API** every 2 s (`apps/api/src/live/monitor.ts`) instead of `runOnReady`/`runOnNotReady` shell hooks, so it works the same on Windows and Linux. The HTTP auth hook is used only for authorization. A stream is considered ended after 2 missed polls.
- **MediaMTX auth hook rules:** `publish` = stream-key check (+ not suspended + quota/disk); every other action (`read`, `api`, …) requires internal basic-auth credentials (`capturecat` / `MEDIAMTX_SECRET`) that only the API uses. The hook URL itself carries `?secret=`.
- **Recording filenames** use `%s-%f` (unix seconds + microseconds), so the worker gets exact wall-clock start times without timezone parsing. `started_at` is first set from MediaMTX's `readyTime`; at finalize the worker re-bases it to the first recording segment and shifts live annotations by the difference (measured within ±1 s in tests).
- **Worker network:** in Docker it sits on an `internal: true` network (database reachable, no internet), rather than "no network", because it needs Postgres. ffmpeg also runs with `-protocol_whitelist file` and a forced, whitelisted demuxer.
- **One packaging job at a time** across both queues (a lock in the worker), since there's no GPU.
- **Annotation counts** are denormalized on `video.annotation_count` (feed badges, "has annotations" filter, "most annotated" sort).
- **Dev login** is `POST /api/dev/login` (plus `GET/POST /api/dev/users`). It calls a Better Auth plugin endpoint internally; the plugin's own `/api/auth/dev/*` route is blocked from outside.
- **Development needs no installs:** Postgres from `embedded-postgres` (npm), ffmpeg/ffprobe from `ffmpeg-static`/`@ffprobe-installer` (npm), MediaMTX downloaded into `tools/mediamtx/`, Playwright's Chromium in `node_modules`.

**Verified on the dev machine:**
- `pnpm test`: 19 unit tests (geometry/letterboxing, timing, live offsets, permissions, quota, schemas).
- `pnpm test:smoke`: 50 end-to-end API checks against the running stack (login wall, dev login, Origin check, tus upload → HLS, remux and CPU-transcode paths, malicious playlist rejected, path traversal, private/public permissions, SSE, suspension, quota refusal, wrong stream key rejected, live HLS has `PROGRAM-DATE-TIME`, live annotation survives finalize, stream disconnected when quota is reached mid-broadcast with the partial recording kept, delete + quota accounting).
- `pnpm test:e2e`: 4 Playwright browser tests (login redirect, dev login, two-user upload → publish → annotate → real-time → click-to-seek, live annotation without pausing → recording).

**Not verified yet:**
- The **Docker/Caddy production stack** (`infra/`): Docker isn't installed on the dev machine, so the Dockerfile and compose file have never been built or run.
- **Real OAuth providers** and the **mock OIDC** compose file: no OAuth apps are configured yet; all testing used dev login.
- **Safari / iOS** playback (native HLS path, `getStartDate()` live clock) and OBS itself (tests push RTMP with ffmpeg).
