#!/bin/bash
# Experience Engine bootstrap
# Starts boot-time/runtime helpers and writes a persisted health snapshot.

set +e

EXP_DIR="${HOME}/.experience"
CONFIG="$EXP_DIR/config.json"
HEALTH_SCRIPT="$EXP_DIR/health-check.sh"
STATUS_DIR="$EXP_DIR/status"
TMP_DIR="$EXP_DIR/tmp"
LOCK_DIR="$TMP_DIR/bootstrap.lock"
LOG_FILE="$STATUS_DIR/bootstrap.log"

REASON="manual"
QUIET=false
SKIP_HEALTH=false

while [ $# -gt 0 ]; do
  case "$1" in
    --reason)
      REASON="${2:-manual}"
      shift 2
      ;;
    --quiet)
      QUIET=true
      shift
      ;;
    --skip-health)
      SKIP_HEALTH=true
      shift
      ;;
    *)
      shift
      ;;
  esac
done

mkdir -p "$STATUS_DIR" "$TMP_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

say() {
  $QUIET || printf '%s\n' "$*"
}

read_cfg() {
  local expr="$1"
  node -e "
    try {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.experience', 'config.json'), 'utf8'));
      const value = (function(c) { return ${expr}; })(cfg);
      process.stdout.write(value == null ? '' : String(value));
    } catch {}
  " 2>/dev/null
}

qdrant_code() {
  local url="$1"
  local key="$2"
  [ -z "$url" ] && return
  if [ -n "$key" ]; then
    curl -s -m 4 -o /dev/null -w "%{http_code}" -H "api-key: $key" "${url%/}/collections" 2>/dev/null
  else
    curl -s -m 4 -o /dev/null -w "%{http_code}" "${url%/}/collections" 2>/dev/null
  fi
}

SERVER_BASE_URL="$(read_cfg "c.serverBaseUrl || ''")"
QDRANT_URL="$(read_cfg "c.qdrantUrl || ''")"
QDRANT_KEY="$(read_cfg "c.qdrantKey || ''")"
TUNNEL_SSH="$(read_cfg "c.tunnelSsh || ''")"

TUNNEL_CONFIGURED=false
TUNNEL_STARTED=false
TUNNEL_REACHABLE=false
TUNNEL_ERROR=""

if [ -n "$TUNNEL_SSH" ]; then
  TUNNEL_CONFIGURED=true
  QDRANT_HTTP="$(qdrant_code "$QDRANT_URL" "$QDRANT_KEY")"
  if [ "$QDRANT_HTTP" != "200" ]; then
    say "Experience Engine bootstrap: starting SSH tunnel"
    if bash -lc "$TUNNEL_SSH" >>"$LOG_FILE" 2>&1; then
      TUNNEL_STARTED=true
      sleep 2
      QDRANT_HTTP="$(qdrant_code "$QDRANT_URL" "$QDRANT_KEY")"
    else
      TUNNEL_ERROR="Failed to start tunnel"
    fi
  fi
  if [ "$QDRANT_HTTP" = "200" ]; then
    TUNNEL_REACHABLE=true
  elif [ -z "$TUNNEL_ERROR" ]; then
    TUNNEL_ERROR="Qdrant still unreachable at ${QDRANT_URL}"
  fi
fi

if $SKIP_HEALTH || [ ! -x "$HEALTH_SCRIPT" ]; then
  exit 0
fi

HEALTH_FILE="$STATUS_DIR/boot-health-$(date +%Y%m%dT%H%M%S).json"
TMP_HEALTH="$TMP_DIR/boot-health.$$.json"

if bash "$HEALTH_SCRIPT" --json >"$TMP_HEALTH" 2>>"$LOG_FILE"; then
  HEALTH_EXIT=0
else
  HEALTH_EXIT=$?
fi

node -e "
  const fs = require('fs');
  const statusPath = process.argv[1];
  const latestPath = process.argv[2];
  const reason = process.argv[3];
  const healthPath = process.argv[4];
  const healthExit = Number(process.argv[5] || 0);
  const tunnelConfigured = process.argv[6] === 'true';
  const tunnelStarted = process.argv[7] === 'true';
  const tunnelReachable = process.argv[8] === 'true';
  const tunnelError = process.argv[9] || '';
  let health = {};
  try {
    health = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
  } catch (error) {
    health = { summary: { pass: 0, warn: 0, fail: 1 }, parseError: error.message };
  }
  const summary = health.summary || { pass: 0, warn: 0, fail: healthExit === 0 ? 0 : 1 };
  const overall = summary.fail > 0 ? 'unhealthy' : summary.warn > 0 ? 'degraded' : 'healthy';
  const snapshot = {
    ts: new Date().toISOString(),
    reason,
    overall,
    exitCode: healthExit,
    bootstrap: {
      tunnelConfigured,
      tunnelStarted,
      tunnelReachable,
      tunnelError,
      thinClient: !!((health.mode || {}).detail || '').match(/Thin client/i),
      serverBaseUrl: process.argv[10] || '',
    },
    health,
  };
  fs.writeFileSync(statusPath, JSON.stringify(snapshot, null, 2));
  try {
    fs.copyFileSync(statusPath, latestPath);
  } catch {}
  process.stdout.write(JSON.stringify(snapshot));
" "$HEALTH_FILE" "$STATUS_DIR/boot-health-latest.json" "$REASON" "$TMP_HEALTH" "$HEALTH_EXIT" "$TUNNEL_CONFIGURED" "$TUNNEL_STARTED" "$TUNNEL_REACHABLE" "$TUNNEL_ERROR" "$SERVER_BASE_URL" >"$TMP_DIR/boot-snapshot.$$.json"

mv "$TMP_DIR/boot-snapshot.$$.json" "$HEALTH_FILE.meta" 2>/dev/null
cp "$HEALTH_FILE.meta" "$STATUS_DIR/boot-health-latest.meta.json" 2>/dev/null
rm -f "$TMP_HEALTH"

say "Experience Engine bootstrap: $(node -e "
  try {
    const fs = require('fs');
    const p = process.argv[1];
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const s = data.health.summary || { pass: 0, warn: 0, fail: 0 };
    process.stdout.write(data.overall.toUpperCase() + ' (' + s.pass + ' pass, ' + s.warn + ' warn, ' + s.fail + ' fail)');
  } catch {
    process.stdout.write('status unavailable');
  }
" "$HEALTH_FILE.meta")"

exit "$HEALTH_EXIT"
