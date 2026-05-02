#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$HOME/experience-engine"
LOG_DIR="$HOME/.experience/logs"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-develop}"
mkdir -p "$LOG_DIR"

cd "$REPO_DIR"
echo "[deploy] repo=$REPO_DIR"
echo "[deploy] current_branch=$(git branch --show-current)"
echo "[deploy] target_branch=$DEPLOY_BRANCH"

git fetch origin "$DEPLOY_BRANCH"
git checkout "$DEPLOY_BRANCH"
git pull --ff-only origin "$DEPLOY_BRANCH"

echo "[deploy] ensuring qdrant container"
docker compose up -d qdrant

echo "[deploy] restarting experience-engine.service"
systemctl --user restart experience-engine.service
sleep 3

echo "[deploy] service status"
systemctl --user status experience-engine.service --no-pager --lines=20

echo "[deploy] health check"
"$REPO_DIR/scripts/health-watch.sh"
cp "$LOG_DIR/health-check-last.json" "$LOG_DIR/deploy-health-last.json" 2>/dev/null || true

echo "[deploy] done"
