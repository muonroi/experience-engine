#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="$HOME/.experience/logs"
KEEP_LOGS=10
FAIL_COUNT_FILE="$LOG_DIR/health-fail-count"
ALERT_LOG="$LOG_DIR/health-alert.log"
mkdir -p "$LOG_DIR"
cd "$HOME/experience-engine"

rotate_logs() {
  local pattern="$1"
  local keep="$2"
  mapfile -t files < <(find "$LOG_DIR" -maxdepth 1 -type f -name "$pattern" -printf '%T@ %p\n' | sort -nr | awk 'NR>'"$keep"' {print $2}')
  if [ "${#files[@]}" -gt 0 ]; then
    rm -f -- "${files[@]}"
  fi
}

run_health() {
  local label="$1"
  local timestamp
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local target="$LOG_DIR/${label}-${timestamp}.json"
  docker compose up -d qdrant >/dev/null
  bash "$HOME/.experience/health-check.sh" --json > "$target"
  cat "$target"
  cp "$target" "$LOG_DIR/health-check-last.json"
  rotate_logs 'health-check-*.json' "$KEEP_LOGS"
  node -e '
let s="";
process.stdin.on("data", c => s += c);
process.stdin.on("end", () => {
  const j = JSON.parse(s);
  process.stdout.write(String((j.summary && j.summary.fail) || 0));
});
' < "$target"
}

# Is the node server process itself reachable? A restart can ONLY fix a dead or
# wedged process — it cannot fix an upstream provider outage (embed/brain API
# down) or Qdrant being down. Restarting on those caused a restart storm
# (2026-06-17: a transient SiliconFlow embed timeout made health-check report a
# failure every 5 min, each triggering a pointless restart, until the provider
# recovered ~80 min later). So the restart is gated on DIRECT server
# reachability; dependency failures are logged + alerted but never restarted.
bump_streak() {
  local prev=0
  [ -f "$FAIL_COUNT_FILE" ] && prev="$(cat "$FAIL_COUNT_FILE" 2>/dev/null || echo 0)"
  FAIL_STREAK=$((prev + 1))
  echo "$FAIL_STREAK" > "$FAIL_COUNT_FILE"
}

server_reachable() {
  local port
  port="$(node -e 'try{const c=require(process.env.HOME+"/.experience/config.json");process.stdout.write(String((c.server&&c.server.port)||c.serverPort||8082))}catch{process.stdout.write("8082")}' 2>/dev/null || echo 8082)"
  curl -sf -m 5 "http://127.0.0.1:${port}/health" >/dev/null 2>&1
}

FAIL="$(run_health health-check | tail -n1)"
if [ "$FAIL" = "0" ]; then
  echo 0 > "$FAIL_COUNT_FILE"
  exit 0
fi

# health-check reported failure(s). Only a wedged/dead node warrants a restart.
if server_reachable; then
  # Server answers /health — failures are upstream deps (embed/brain provider,
  # Qdrant, network). Track the streak for alerting, but DO NOT restart.
  bump_streak
  echo "[health] fail=$FAIL but server reachable — upstream/dependency issue, NOT restarting (streak=$FAIL_STREAK)"
  if [ "$FAIL_STREAK" -ge 3 ]; then
    printf '%s [health-alert] dependency_failure streak=%s fail=%s (server up, restart suppressed)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$FAIL_STREAK" "$FAIL" | tee -a "$ALERT_LOG" >&2
  fi
  exit 0
fi

# Server is unreachable/wedged — the one case a restart actually fixes.
bump_streak
echo "[health] server unreachable on /health, restarting experience-engine.service (streak=$FAIL_STREAK)"
systemctl --user restart experience-engine.service || true
sleep 3
if server_reachable; then
  echo 0 > "$FAIL_COUNT_FILE"
  exit 0
fi

if [ "$FAIL_STREAK" -ge 3 ]; then
  printf '%s [health-alert] server_unreachable_after_restart streak=%s pre_restart_fail=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$FAIL_STREAK" "$FAIL" | tee -a "$ALERT_LOG" >&2
fi
exit 1
