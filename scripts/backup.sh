#!/usr/bin/env sh
# Production backup: database dump + media volume. Run on the server from the repo root.
#   sh scripts/backup.sh [backup-dir]
# Restore: gunzip -c db-*.sql.gz | docker compose ... exec -T postgres psql -U capturecat capturecat
#          and untar media-*.tar into the media volume.
set -eu
DEST="${1:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
COMPOSE="docker compose -f infra/docker-compose.yml --env-file infra/.env"
mkdir -p "$DEST"
$COMPOSE exec -T postgres pg_dump -U capturecat capturecat | gzip > "$DEST/db-$STAMP.sql.gz"
# Media is already compressed video: plain tar, no gzip.
docker run --rm -v capturecat_media:/data:ro -v "$(cd "$DEST" && pwd)":/backup alpine \
  tar cf "/backup/media-$STAMP.tar" -C /data media
echo "Backup written to $DEST (db-$STAMP.sql.gz, media-$STAMP.tar)"
