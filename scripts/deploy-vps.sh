#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$HOME/experience-engine"
LOG_DIR="$HOME/.experience/logs"
mkdir -p "$LOG_DIR"

cd "$REPO_DIR"
echo "[deploy] repo=$REPO_DIR"
echo "[deploy] branch=$(git branch --show-current)"

git fetch origin develop
git checkout develop
git pull --ff-only origin develop

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
