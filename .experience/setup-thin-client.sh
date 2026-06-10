#!/bin/bash
set -euo pipefail

INSTALL_DIR="${HOME}/.experience"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SRC_DIR/.." && pwd)"

SERVER_URL=""
SERVER_TOKEN=""
SERVER_READ_TOKEN=""
ORG_NAME="${EXP_ORG_NAME:-}"
ORG_PATTERNS="${EXP_ORG_PATTERNS:-}"
HOOK_TIMEOUT_MS=""
CLEAN_MODE=false
CONFIG_FALLBACK_FILE="${HOME}/.experience/config.json"

while [ $# -gt 0 ]; do
  case "$1" in
    --server)
      SERVER_URL="${2:-}"
      shift 2
      ;;
    --token)
      SERVER_TOKEN="${2:-}"
      shift 2
      ;;
    --read-token)
      SERVER_READ_TOKEN="${2:-}"
      shift 2
      ;;
    --org-name)
      ORG_NAME="${2:-}"
      shift 2
      ;;
    --org-patterns)
      ORG_PATTERNS="${2:-}"
      shift 2
      ;;
    --hook-timeout)
      HOOK_TIMEOUT_MS="${2:-}"
      shift 2
      ;;
    --clean)
      CLEAN_MODE=true
      shift
      ;;
    --help|-h)
      cat <<'EOF'
Usage:
  bash .experience/setup-thin-client.sh [options]

Options:
  --server URL         Optional if ~/.experience/config.json already contains serverBaseUrl.
  --token TOKEN        Bearer token for POST endpoints.
  --read-token TOKEN   Read-only token for /api/stats and /api/gates.
  --org-name SLUG      Org slug for cross-project hint filter (empty = global mode).
                       Env: EXP_ORG_NAME
  --org-patterns LIST  Comma-sep repo patterns matched against project slug
                       (`*` glob ok). Auto-included: <orgName>, <orgName>-*.
                       Env: EXP_ORG_PATTERNS
  --hook-timeout MS    Client hook abort timeout in ms (default keep existing
                       or fall back to engine default 2500).
  --clean              Backup and remove old local brain state.

Fallback:
  Flags missing → reuse values from ~/.experience/config.json (server*, org,
  serverHookTimeoutMs). Re-runs are idempotent: existing config values are
  preserved unless overridden by a flag/env var.
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

load_config_fallback() {
  local key="$1"
  local config_file="$2"
  if [ ! -f "$config_file" ]; then
    return 0
  fi

  node -e '
    const fs = require("fs");
    const [configFile, key] = process.argv.slice(1);
    try {
      const raw = fs.readFileSync(configFile, "utf8");
      const parsed = JSON.parse(raw);
      const value = parsed[key];
      if (typeof value === "string") process.stdout.write(value);
    } catch (error) {
      process.stderr.write(`[WARN] Failed to read ${configFile}: ${error.message}\n`);
      process.exit(1);
    }
  ' "$config_file" "$key"
}

if [ -z "$SERVER_URL" ]; then
  SERVER_URL="$(load_config_fallback serverBaseUrl "$CONFIG_FALLBACK_FILE")"
fi

if [ -z "$SERVER_TOKEN" ]; then
  SERVER_TOKEN="$(load_config_fallback serverAuthToken "$CONFIG_FALLBACK_FILE")"
fi

if [ -z "$SERVER_READ_TOKEN" ]; then
  SERVER_READ_TOKEN="$(load_config_fallback serverReadAuthToken "$CONFIG_FALLBACK_FILE")"
fi

if [ -z "$HOOK_TIMEOUT_MS" ]; then
  HOOK_TIMEOUT_MS="$(load_config_fallback serverHookTimeoutMs "$CONFIG_FALLBACK_FILE")"
fi

# Preserve existing org block from config when flags absent.
EXISTING_ORG_JSON=""
if [ -f "$CONFIG_FALLBACK_FILE" ] && [ -z "$ORG_NAME" ]; then
  EXISTING_ORG_JSON=$(node -e '
    try {
      const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (c.org && typeof c.org.name === "string" && c.org.name.trim()) {
        process.stdout.write(JSON.stringify(c.org));
      }
    } catch {}
  ' "$CONFIG_FALLBACK_FILE")
fi

if [ -z "$SERVER_URL" ]; then
  echo "[ERROR] --server is required (or set serverBaseUrl in $CONFIG_FALLBACK_FILE)" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/tmp" "$INSTALL_DIR/offline-queue"
rm -rf "$INSTALL_DIR/tmp/bootstrap.lock"

ensure_line_in_file() {
  local file="$1" line="$2"
  mkdir -p "$(dirname "$file")"
  touch "$file"
  grep -Fqx "$line" "$file" 2>/dev/null || printf '\n%s\n' "$line" >> "$file"
}

# ── Thin-client minimum file set ───────────────────────────────────────────
#
# Thin-client routes EVERY brain operation through remote-client.js → VPS.
# It does NOT need:
#   - experience-core.js (full local brain)
#   - src/* modules (router, qdrant, embedding — all server-side)
#     EXCEPTION: src/config.js is installed standalone below — it is the
#     single source of truth for the trivial-prompt gate knobs
#     (getMinPromptLength / getPromptSkipRegex) read by interceptor-prompt.js.
#     It requires only Node built-ins (fs/path/os/crypto), so a lone copy
#     cannot drift the client half-local (interceptors still gate on
#     isRemoteMode() and never load core).
#   - judge-worker.js (judge runs on the server)
#   - activity-watch.js + exp-pane-* + exp-open-pane + exp-watch
#     (these tail local activity.jsonl which only the server writes)
#   - exp-server-maintain.js (server admin)
#   - exp-portable-backup.js / exp-portable-restore.js (talk to local Qdrant)
#
# Anything not in this list is a smell — interceptors check isRemoteMode()
# before requiring core, so installing core locally will silently drift the
# thin-client into a half-local state on the next interceptor invocation.
THIN_CLIENT_FILES=(
  interceptor.js
  interceptor-post.js
  interceptor-prompt.js
  interceptor-session.js
  source-meta-enrich.js
  stop-extractor.js
  remote-client.js
  extract-compact.js
  exp-client-drain.js
  health-check.sh
  exp-feedback.js
  exp-feedback
  exp-recall.js
  exp-bootstrap.sh
  exp-health-last
  exp-shell-init.sh
  sync-install.sh
  register-hooks.js
)

for f in "${THIN_CLIENT_FILES[@]}"; do
  cp "$SRC_DIR/$f" "$INSTALL_DIR/$f"
done

chmod +x \
  "$INSTALL_DIR/interceptor.js" \
  "$INSTALL_DIR/interceptor-post.js" \
  "$INSTALL_DIR/interceptor-prompt.js" \
  "$INSTALL_DIR/interceptor-session.js" \
  "$INSTALL_DIR/stop-extractor.js" \
  "$INSTALL_DIR/remote-client.js" \
  "$INSTALL_DIR/extract-compact.js" \
  "$INSTALL_DIR/exp-client-drain.js" \
  "$INSTALL_DIR/health-check.sh" \
  "$INSTALL_DIR/exp-feedback.js" \
  "$INSTALL_DIR/exp-feedback" \
  "$INSTALL_DIR/exp-recall.js" \
  "$INSTALL_DIR/exp-bootstrap.sh" \
  "$INSTALL_DIR/exp-health-last" \
  "$INSTALL_DIR/exp-shell-init.sh" \
  "$INSTALL_DIR/sync-install.sh" \
  "$INSTALL_DIR/register-hooks.js"

# ── Prune local-only artefacts ─────────────────────────────────────────────
#
# Idempotent. If a prior full setup.sh (or sync-install) dropped local-only
# files into ~/.experience, remove them so this machine becomes a true thin
# client. These removals are SAFE — nothing in THIN_CLIENT_FILES requires
# them at runtime (interceptors check isRemoteMode() and never reach core
# in thin mode).
LOCAL_ONLY_FILES=(
  experience-core.js
  judge-worker.js
  activity-watch.js
  exp-server-maintain.js
  exp-portable-backup.js
  exp-portable-restore.js
  exp-open-pane
  exp-watch
  exp-pane-bottom
  exp-pane-left
  exp-pane-right
)

PRUNE_STAMP="$(date +%Y%m%d-%H%M%S)"
PRUNE_BACKUP="$INSTALL_DIR/backup-thin-client/$PRUNE_STAMP-prune"
pruned=0
for f in "${LOCAL_ONLY_FILES[@]}"; do
  if [ -e "$INSTALL_DIR/$f" ]; then
    mkdir -p "$PRUNE_BACKUP"
    mv "$INSTALL_DIR/$f" "$PRUNE_BACKUP/$f"
    pruned=$((pruned + 1))
  fi
done
if [ -d "$INSTALL_DIR/src" ]; then
  mkdir -p "$PRUNE_BACKUP"
  mv "$INSTALL_DIR/src" "$PRUNE_BACKUP/src"
  pruned=$((pruned + 1))
fi
if [ "$pruned" -gt 0 ]; then
  echo "  ✓ Pruned $pruned local-only artefacts (backup: $PRUNE_BACKUP)"
fi

# ── Install standalone src/config.js (trivial-prompt gate knobs) ────────────
#
# Runs AFTER the src/ prune above so we end with a src/ dir containing ONLY
# config.js — the single source of truth for getMinPromptLength /
# getPromptSkipRegex consumed by interceptor-prompt.js loadTrivialityConfig().
# config.js requires only Node built-ins, so this lone copy is thin-safe.
if [ -f "$SRC_DIR/src/config.js" ]; then
  mkdir -p "$INSTALL_DIR/src"
  cp "$SRC_DIR/src/config.js" "$INSTALL_DIR/src/config.js"
  echo "  ✓ Installed src/config.js (trivial-prompt gate config)"
else
  echo "  ! src/config.js missing in repo — triviality gate will fail open to inline defaults" >&2
fi

mkdir -p "$HOME/.local/bin"
ln -sf "$INSTALL_DIR/exp-feedback" "$HOME/.local/bin/exp-feedback"
ln -sf "$INSTALL_DIR/exp-health-last" "$HOME/.local/bin/exp-health-last"
ensure_line_in_file "$HOME/.bashrc" 'export PATH="$HOME/.local/bin:$PATH"'
ensure_line_in_file "$HOME/.zshrc" 'export PATH="$HOME/.local/bin:$PATH"'
ensure_line_in_file "$HOME/.bashrc" '[ -f "$HOME/.experience/exp-shell-init.sh" ] && . "$HOME/.experience/exp-shell-init.sh"'
ensure_line_in_file "$HOME/.zshrc" '[ -f "$HOME/.experience/exp-shell-init.sh" ] && . "$HOME/.experience/exp-shell-init.sh"'

STAMP="$(date +%Y%m%d-%H%M%S)"
if $CLEAN_MODE; then
  BACKUP_DIR="$INSTALL_DIR/backup-thin-client/$STAMP"
  mkdir -p "$BACKUP_DIR"
  for target in config.json activity.jsonl store .evolve-marker .stop-marker.json tmp/last-suggestions.json; do
    if [ -e "$INSTALL_DIR/$target" ]; then
      mkdir -p "$BACKUP_DIR/$(dirname "$target")"
      mv "$INSTALL_DIR/$target" "$BACKUP_DIR/$target"
    fi
  done
fi

# Atomic config write — preserves org block + hook timeout from prior install
# unless explicitly overridden by flags/env.
INSTALLED_AT="$(date -Iseconds)"
# Capture the repo commit this install was sourced from. Lets the server log
# stale clients and lets `bash upgrade.sh` / health-check compare against the
# current origin. Falls back to "unknown" outside a git checkout.
INSTALL_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null | head -c 12 || true)"
INSTALL_COMMIT="${INSTALL_COMMIT:-unknown}"
INSTALL_COMMIT_DATE="$(git -C "$ROOT_DIR" log -1 --format=%cI 2>/dev/null || true)"
INSTALL_COMMIT_DATE="${INSTALL_COMMIT_DATE:-}"
node -e '
const fs = require("fs");
const path = require("path");
const [target, serverUrl, token, readToken, hookTimeoutRaw, orgName, orgPatternsRaw, existingOrgJson, installedAt, installCommit, installCommitDate] = process.argv.slice(1);
const cfg = {
  serverBaseUrl: serverUrl.replace(/\/$/, ""),
  serverAuthToken: token,
  serverReadAuthToken: readToken,
  serverTimeoutMs: 5000,
  serverExtractTimeoutMs: 60000,
  version: "thin-client",
  installedAt,
  installCommit: installCommit || "unknown",
  ...(installCommitDate ? { installCommitDate } : {}),
};
const hookTimeout = parseInt(hookTimeoutRaw, 10);
if (Number.isFinite(hookTimeout) && hookTimeout > 0) cfg.serverHookTimeoutMs = hookTimeout;
if (orgName && orgName.trim()) {
  const patterns = orgPatternsRaw
    ? orgPatternsRaw.split(",").map(s => s.trim()).filter(Boolean)
    : [];
  // Preserve unknown org.* keys (frameworkPackages, globalScope, etc.) from
  // a prior install — re-running setup should never silently drop config
  // fields the user added manually.
  let preserved = {};
  if (existingOrgJson) {
    try {
      const prev = JSON.parse(existingOrgJson);
      if (prev && typeof prev === "object") {
        for (const [k, v] of Object.entries(prev)) {
          if (k !== "name" && k !== "repoPatterns") preserved[k] = v;
        }
      }
    } catch {}
  }
  cfg.org = Object.assign({ name: orgName.trim(), repoPatterns: patterns }, preserved);
} else if (existingOrgJson) {
  try { cfg.org = JSON.parse(existingOrgJson); } catch {}
}
const tmp = target + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
fs.renameSync(tmp, target);
' \
  "$INSTALL_DIR/config.json" \
  "$SERVER_URL" \
  "$SERVER_TOKEN" \
  "$SERVER_READ_TOKEN" \
  "$HOOK_TIMEOUT_MS" \
  "$ORG_NAME" \
  "$ORG_PATTERNS" \
  "$EXISTING_ORG_JSON" \
  "$INSTALLED_AT" \
  "$INSTALL_COMMIT" \
  "$INSTALL_COMMIT_DATE"

# Re-apply agent hook registration in 'existing-only' mode so upgrades pick up
# new hook entries (e.g., Claude UserPromptSubmit, needed to work around
# anthropics/claude-code#19432) without auto-wiring agents the user never
# opted in to. Idempotent: skips any (matcher, command) already present.
to_fwd_path() {
  echo "$1" | sed 's|\\|/|g' | sed 's|^/\([a-zA-Z]\)/|\1:/|'
}
if [ -f "$INSTALL_DIR/register-hooks.js" ]; then
  EXP_INTERCEPTOR="$(to_fwd_path "$INSTALL_DIR/interceptor.js")" \
    EXP_INTERCEPTOR_POST="$(to_fwd_path "$INSTALL_DIR/interceptor-post.js")" \
    EXP_INTERCEPTOR_PROMPT="$(to_fwd_path "$INSTALL_DIR/interceptor-prompt.js")" \
    EXP_INTERCEPTOR_SESSION="$(to_fwd_path "$INSTALL_DIR/interceptor-session.js")" \
    EXP_STOP="$(to_fwd_path "$INSTALL_DIR/stop-extractor.js")" \
    EXP_REGISTER_MODE="existing-only" \
    node "$INSTALL_DIR/register-hooks.js" || echo "(non-fatal: register-hooks failed)"
fi

echo
echo "Thin client installed to $INSTALL_DIR"
if $CLEAN_MODE; then
  echo "Local canonical state backed up under $INSTALL_DIR/backup-thin-client/$STAMP"
fi
echo
bash "$INSTALL_DIR/health-check.sh"
echo "Feedback helper: exp-feedback ignored a1b2c3d4 experience-selfqa"
