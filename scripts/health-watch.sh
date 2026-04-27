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

FAIL="$(run_health health-check | tail -n1)"
if [ "$FAIL" = "0" ]; then
  echo 0 > "$FAIL_COUNT_FILE"
  exit 0
fi

PREV_FAILS=0
if [ -f "$FAIL_COUNT_FILE" ]; then
  PREV_FAILS="$(cat "$FAIL_COUNT_FILE" 2>/dev/null || echo 0)"
fi
FAIL_STREAK=$((PREV_FAILS + 1))
echo "$FAIL_STREAK" > "$FAIL_COUNT_FILE"

echo "[health] detected fail=$FAIL, restarting experience-engine.service"
systemctl --user restart experience-engine.service || true
sleep 3
POST_FAIL="$(run_health health-check-after-restart | tail -n1)"
if [ "$POST_FAIL" = "0" ]; then
  echo 0 > "$FAIL_COUNT_FILE"
  exit 0
fi

echo "$FAIL_STREAK" > "$FAIL_COUNT_FILE"
if [ "$FAIL_STREAK" -ge 3 ]; then
  printf '%s [health-alert] consecutive_failures=%s pre_restart_fail=%s post_restart_fail=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$FAIL_STREAK" "$FAIL" "$POST_FAIL" | tee -a "$ALERT_LOG" >&2
fi
exit 1
