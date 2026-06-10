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
copy_file "$SRC_DIR/interceptor-session.js" "interceptor-session.js"
copy_file "$SRC_DIR/interceptor.js" "interceptor.js"
copy_file "$SRC_DIR/register-hooks.js" "register-hooks.js"
copy_file "$SRC_DIR/judge-worker.js" "judge-worker.js"
copy_file "$SRC_DIR/remote-client.js" "remote-client.js"
copy_file "$SRC_DIR/source-meta-enrich.js" "source-meta-enrich.js"
copy_file "$SRC_DIR/stop-extractor.js" "stop-extractor.js"
copy_file "$SRC_DIR/sync-install.sh" "sync-install.sh"
copy_file "$ROOT_DIR/tools/exp-server-maintain.js" "exp-server-maintain.js"
copy_file "$ROOT_DIR/tools/exp-portable-backup.js" "exp-portable-backup.js"
copy_file "$ROOT_DIR/tools/exp-portable-restore.js" "exp-portable-restore.js"

# Sync src/ modules (required after modular refactor)
if [ -d "$SRC_DIR/src" ]; then
  mkdir -p "$TARGET_DIR/src"
  for f in "$SRC_DIR/src/"*.js; do
    [ -f "$f" ] || continue
    install -m 644 "$f" "$TARGET_DIR/src/$(basename "$f")"
    log "Synced: src/$(basename "$f")"
  done
fi

# Stamp the current repo commit into config.json. Lets the server log stale
# clients (via X-EE-Client-Commit header) and lets health-check.sh diff
# install vs origin without re-running setup. Idempotent: only touches the
# two fields below, preserves everything else.
INSTALL_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null | head -c 12 || true)"
INSTALL_COMMIT="${INSTALL_COMMIT:-unknown}"
INSTALL_COMMIT_DATE="$(git -C "$ROOT_DIR" log -1 --format=%cI 2>/dev/null || true)"
if [ -f "$TARGET_DIR/config.json" ] && [ "$INSTALL_COMMIT" != "unknown" ]; then
  node -e '
    const fs = require("fs");
    const [target, commit, commitDate] = process.argv.slice(1);
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(target, "utf8")); } catch {}
    cfg.installCommit = commit;
    if (commitDate) cfg.installCommitDate = commitDate;
    const tmp = target + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, target);
  ' "$TARGET_DIR/config.json" "$INSTALL_COMMIT" "$INSTALL_COMMIT_DATE"
  log "Stamped installCommit=$INSTALL_COMMIT"
fi

# Re-apply agent hook registration in 'existing-only' mode so upgrades pick up
# new hook entries (e.g., Claude UserPromptSubmit, needed to work around
# anthropics/claude-code#19432) without auto-wiring agents the user never
# opted in to during initial setup. Idempotent: skips any (matcher, command)
# already present.
to_fwd() {
  echo "$1" | sed 's|\\|/|g' | sed 's|^/\([a-zA-Z]\)/|\1:/|'
}
INTERCEPTOR_FWD=$(to_fwd "$TARGET_DIR/interceptor.js")
INTERCEPTOR_POST_FWD=$(to_fwd "$TARGET_DIR/interceptor-post.js")
INTERCEPTOR_PROMPT_FWD=$(to_fwd "$TARGET_DIR/interceptor-prompt.js")
INTERCEPTOR_SESSION_FWD=$(to_fwd "$TARGET_DIR/interceptor-session.js")
STOP_FWD=$(to_fwd "$TARGET_DIR/stop-extractor.js")

if [ -f "$TARGET_DIR/register-hooks.js" ]; then
  log "Re-applying agent hook registration (existing-only)..."
  EXP_INTERCEPTOR="$INTERCEPTOR_FWD" \
    EXP_INTERCEPTOR_POST="$INTERCEPTOR_POST_FWD" \
    EXP_INTERCEPTOR_PROMPT="$INTERCEPTOR_PROMPT_FWD" \
    EXP_INTERCEPTOR_SESSION="$INTERCEPTOR_SESSION_FWD" \
    EXP_STOP="$STOP_FWD" \
    EXP_REGISTER_MODE="existing-only" \
    node "$TARGET_DIR/register-hooks.js" || log "  (non-fatal: register-hooks failed)"
fi

log "Runtime sync complete: $TARGET_DIR"
