# One build, three targets:
#   app    API + worker (Node, tsx, system ffmpeg)
#   caddy  reverse proxy + HTTPS + the built SPA
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN npm install -g pnpm@10.34.9
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .

FROM deps AS web-build
RUN pnpm --filter @capturecat/web build

FROM deps AS app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    DATA_DIR=/data
# /data is a shared volume: owned by node (uid 1000); MediaMTX also runs as 1000:1000.
RUN mkdir -p /data && chown node:node /data
USER node
# The command (api or worker) is set per service in docker-compose.yml.

FROM caddy:2.10 AS caddy
COPY infra/Caddyfile infra/sites-*.caddy /etc/caddy/
COPY --from=web-build /app/apps/web/dist /srv/web
