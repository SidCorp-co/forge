#!/bin/bash
# Deploy main → staging VPS via SSH + docker compose.
#
# Idempotent: pulls latest origin/main, rebuilds core+web images, restarts
# containers, verifies /health. Exits non-zero on any failure.
#
# Prerequisites:
#   - SSH access to $VPS_HOST as root (key auth, no password)
#   - $VPS_PATH exists on VPS with docker-compose.prod.yml + .env present
#   - main is up to date locally; this script only deploys what's on origin/main
#
# Usage:  pnpm deploy:staging   (or)   bash scripts/deploy-staging.sh

set -euo pipefail

VPS_HOST="${STAGING_VPS_HOST:-root@165.22.96.128}"
VPS_PATH="${STAGING_VPS_PATH:-/opt/jarvis-stg-a2}"
PROJECT="${STAGING_PROJECT:-jarvis-stg-a2}"
HEALTH_URL="${STAGING_HEALTH_URL:-https://stg-jarvis-a2.thejunix.com/health}"
COMPOSE_FILE="${STAGING_COMPOSE_FILE:-docker-compose.prod.yml}"

ts() { date -u +%H:%M:%S; }
log() { echo "[deploy-stg $(ts)] $*"; }

log "target: $VPS_HOST:$VPS_PATH ($PROJECT)"
log "ssh + git fetch + reset to origin/main"

ssh -o ConnectTimeout=10 -o BatchMode=yes "$VPS_HOST" bash -s <<EOF || { log "FAIL: ssh/git/docker step"; exit 1; }
  set -euo pipefail
  cd '$VPS_PATH'
  BEFORE=\$(git rev-parse HEAD)
  git fetch --depth=10 origin main
  git reset --hard FETCH_HEAD
  AFTER=\$(git rev-parse HEAD)
  if [ "\$BEFORE" = "\$AFTER" ]; then
    echo '[stg] no change — HEAD already at origin/main ('\$AFTER')'
    NEED_BUILD=0
  else
    echo '[stg] '\$BEFORE' → '\$AFTER
    NEED_BUILD=1
  fi
  echo '[stg] docker compose build core web'
  docker compose -f '$COMPOSE_FILE' -p '$PROJECT' build core web
  echo '[stg] docker compose up -d --force-recreate core web'
  docker compose -f '$COMPOSE_FILE' -p '$PROJECT' up -d --force-recreate core web
  echo '[stg] container status:'
  docker compose -f '$COMPOSE_FILE' -p '$PROJECT' ps core web
  echo '[stg] HEAD = '\$AFTER
EOF

log "wait 5s for containers to settle"
sleep 5

log "verify $HEALTH_URL"
HEALTH=$(curl -s --max-time 15 "$HEALTH_URL" || echo '{"ok":false,"error":"curl-failed"}')
echo "[deploy-stg] response: $HEALTH"

if echo "$HEALTH" | grep -q '"ok":true'; then
  log "OK"
  exit 0
else
  log "FAIL: /health did not report ok=true. Investigate manually:"
  log "  ssh $VPS_HOST 'cd $VPS_PATH && docker compose -f $COMPOSE_FILE -p $PROJECT logs --tail=50 core web'"
  exit 1
fi
