#!/bin/bash
set -euo pipefail

INSTALL_DIR="${HOME}/.experience"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SRC_DIR/.." && pwd)"

SERVER_URL=""
SERVER_TOKEN=""
SERVER_READ_TOKEN=""
CLEAN_MODE=false

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
    --clean)
      CLEAN_MODE=true
      shift
      ;;
    --help|-h)
      cat <<'EOF'
Usage:
  bash .experience/setup-thin-client.sh --server http://your-vps:8082 [--token TOKEN] [--read-token TOKEN] [--clean]

Options:
  --server   Required. Experience Engine VPS base URL.
  --token    Optional. Bearer token used by POST endpoints.
  --read-token Optional. Read-only token for /api/stats and /api/gates.
  --clean    Backup and remove old local brain state so this machine becomes a true thin client.
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$SERVER_URL" ]; then
  echo "[ERROR] --server is required" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/tmp" "$INSTALL_DIR/offline-queue"

ensure_line_in_file() {
  local file="$1" line="$2"
  mkdir -p "$(dirname "$file")"
  touch "$file"
  grep -Fqx "$line" "$file" 2>/dev/null || printf '\n%s\n' "$line" >> "$file"
}

for f in interceptor.js interceptor-post.js interceptor-prompt.js stop-extractor.js remote-client.js extract-compact.js exp-client-drain.js health-check.sh exp-feedback.js exp-feedback exp-bootstrap.sh exp-health-last exp-shell-init.sh sync-install.sh; do
  cp "$SRC_DIR/$f" "$INSTALL_DIR/$f"
done

for f in exp-server-maintain.js exp-portable-backup.js exp-portable-restore.js; do
  cp "$ROOT_DIR/tools/$f" "$INSTALL_DIR/$f"
done

chmod +x \
  "$INSTALL_DIR/interceptor.js" \
  "$INSTALL_DIR/interceptor-post.js" \
  "$INSTALL_DIR/interceptor-prompt.js" \
  "$INSTALL_DIR/stop-extractor.js" \
  "$INSTALL_DIR/remote-client.js" \
  "$INSTALL_DIR/extract-compact.js" \
  "$INSTALL_DIR/exp-client-drain.js" \
  "$INSTALL_DIR/health-check.sh" \
  "$INSTALL_DIR/exp-feedback.js" \
  "$INSTALL_DIR/exp-feedback" \
  "$INSTALL_DIR/exp-bootstrap.sh" \
  "$INSTALL_DIR/exp-health-last" \
  "$INSTALL_DIR/exp-shell-init.sh" \
  "$INSTALL_DIR/sync-install.sh" \
  "$INSTALL_DIR/exp-server-maintain.js" \
  "$INSTALL_DIR/exp-portable-backup.js" \
  "$INSTALL_DIR/exp-portable-restore.js"

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

cat > "$INSTALL_DIR/config.json" <<EOF
{
  "serverBaseUrl": "${SERVER_URL%/}",
  "serverAuthToken": "${SERVER_TOKEN}",
  "serverReadAuthToken": "${SERVER_READ_TOKEN}",
  "serverTimeoutMs": 5000,
  "serverExtractTimeoutMs": 60000,
  "version": "thin-client",
  "installedAt": "$(date -Iseconds)"
}
EOF

echo
echo "Thin client installed to $INSTALL_DIR"
if $CLEAN_MODE; then
  echo "Local canonical state backed up under $INSTALL_DIR/backup-thin-client/$STAMP"
fi
echo
bash "$INSTALL_DIR/health-check.sh"
echo "Feedback helper: exp-feedback ignored a1b2c3d4 experience-selfqa"
