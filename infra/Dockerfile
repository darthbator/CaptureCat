# syntax=docker/dockerfile:1
# Two images:
#   app    API + worker: Node, tsx, Debian's ffmpeg, production dependencies only
#   caddy  reverse proxy + HTTPS + the built SPA
# The pnpm store is a BuildKit cache mount, so rebuilds don't download packages again.

FROM node:22-bookworm-slim AS pnpm
RUN npm install -g pnpm@10.34.9
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/

# --- SPA build (only its output reaches the caddy image) ---
FROM pnpm AS web-build
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@capturecat/web..."
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/web ./apps/web
RUN pnpm --filter @capturecat/web build

# --- Production node_modules for the API and worker (no dev tools, no web deps) ---
FROM pnpm AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --config.package-import-method=copy \
      --filter "@capturecat/api..." --filter "@capturecat/worker..."

FROM node:22-bookworm-slim AS app
# System packages first: this layer is cached independently of code and dependency changes.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    DATA_DIR=/data
# /data is a shared volume: owned by node (uid 1000); MediaMTX also runs as 1000:1000.
RUN mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=prod-deps /app ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
USER node
# The command (api or worker) and working_dir are set per service in docker-compose.yml.

FROM caddy:2.10 AS caddy
COPY infra/Caddyfile infra/sites-*.caddy /etc/caddy/
COPY --from=web-build /app/apps/web/dist /srv/web
