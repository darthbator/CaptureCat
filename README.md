# Capture Cat

Self-hosted live streaming and video annotation. Stream from OBS or upload recordings, then
click anywhere on a video to pin a comment to that spot and moment. Published videos show up
in a feed where any signed-in user can annotate them, even while a stream is live.

## Run it locally

No Docker or system installs needed: Postgres, ffmpeg and MediaMTX all come from npm or a
download into `tools/`.

```sh
npx pnpm@10.34.9 install
node scripts/get-mediamtx.mjs        # once: downloads MediaMTX into tools/mediamtx/
npx pnpm@10.34.9 dev                 # Postgres, MediaMTX, API, worker and web together
npx pnpm@10.34.9 seed                # in a second terminal, once: dev users
```

Open http://localhost:5173 → **Dev login** → pick Alice, Bob, Admin or Quota Full.

Stream as Alice from OBS: server `rtmp://localhost:1935/live`, stream key `alice?key=dev`.

## Tests

```sh
npx pnpm@10.34.9 test          # unit tests
npx pnpm@10.34.9 test:smoke    # API end-to-end checks (needs `dev` running)
npx pnpm@10.34.9 test:e2e      # browser tests (Playwright)
```

## Deploy

See `infra/`: copy `infra/.env.example` to `infra/.env`, set your domain, secrets and OAuth
apps, then `docker compose -f infra/docker-compose.yml --env-file infra/.env up -d --build`.
The production stack hasn't been run yet (see `docs/ARCHITECTURE.md` §9).

Design and decisions: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
