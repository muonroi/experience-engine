#!/bin/bash
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SRC_DIR/.." && pwd)"
TARGET_DIR="${HOME}/.experience"
QUIET=false

while [ $# -gt 0 ]; do
  case "$1" in
    --quiet)
      QUIET=true
      shift
      ;;
    --help|-h)
      cat <<'EOF'
Usage:
  bash .experience/sync-install.sh [--quiet]

Sync the packaged or repo runtime files from the current source tree into ~/.experience
without overwriting config.json or local store data.
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

log() {
  if [ "$QUIET" != "true" ]; then
    echo "$@"
  fi
}

mkdir -p "$TARGET_DIR" "$TARGET_DIR/tmp" "$TARGET_DIR/store"

copy_file() {
  local source="$1"
  local target_name="$2"
  install -m 755 "$source" "$TARGET_DIR/$target_name"
  log "Synced: $target_name"
}

copy_file "$SRC_DIR/activity-watch.js" "activity-watch.js"
copy_file "$SRC_DIR/exp-bootstrap.sh" "exp-bootstrap.sh"
copy_file "$SRC_DIR/exp-client-drain.js" "exp-client-drain.js"
copy_file "$SRC_DIR/exp-feedback.js" "exp-feedback.js"
copy_file "$SRC_DIR/exp-feedback" "exp-feedback"
copy_file "$SRC_DIR/exp-health-last" "exp-health-last"
copy_file "$SRC_DIR/exp-open-pane" "exp-open-pane"
copy_file "$SRC_DIR/exp-pane-bottom" "exp-pane-bottom"
copy_file "$SRC_DIR/exp-pane-left" "exp-pane-left"
copy_file "$SRC_DIR/exp-pane-right" "exp-pane-right"
copy_file "$SRC_DIR/exp-shell-init.sh" "exp-shell-init.sh"
copy_file "$SRC_DIR/exp-watch" "exp-watch"
copy_file "$SRC_DIR/experience-core.js" "experience-core.js"
copy_file "$SRC_DIR/extract-compact.js" "extract-compact.js"
copy_file "$SRC_DIR/health-check.sh" "health-check.sh"
copy_file "$SRC_DIR/interceptor-post.js" "interceptor-post.js"
copy_file "$SRC_DIR/interceptor-prompt.js" "interceptor-prompt.js"
copy_file "$SRC_DIR/interceptor.js" "interceptor.js"
copy_file "$SRC_DIR/judge-worker.js" "judge-worker.js"
copy_file "$SRC_DIR/remote-client.js" "remote-client.js"
copy_file "$SRC_DIR/stop-extractor.js" "stop-extractor.js"
copy_file "$SRC_DIR/sync-install.sh" "sync-install.sh"
copy_file "$ROOT_DIR/tools/exp-server-maintain.js" "exp-server-maintain.js"
copy_file "$ROOT_DIR/tools/exp-portable-backup.js" "exp-portable-backup.js"
copy_file "$ROOT_DIR/tools/exp-portable-restore.js" "exp-portable-restore.js"

log "Runtime sync complete: $TARGET_DIR"
