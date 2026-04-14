#!/bin/bash
set -euo pipefail

INSTALL_DIR="${HOME}/.experience"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SRC_DIR/.." && pwd)"

SERVER_URL=""
SERVER_TOKEN=""
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
    --clean)
      CLEAN_MODE=true
      shift
      ;;
    --help|-h)
      cat <<'EOF'
Usage:
  bash .experience/setup-thin-client.sh --server http://your-vps:8082 [--token TOKEN] [--clean]

Options:
  --server   Required. Experience Engine VPS base URL.
  --token    Optional. Bearer token used by POST endpoints.
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

for f in interceptor.js interceptor-post.js interceptor-prompt.js stop-extractor.js remote-client.js extract-compact.js exp-client-drain.js health-check.sh; do
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
  "$INSTALL_DIR/exp-server-maintain.js" \
  "$INSTALL_DIR/exp-portable-backup.js" \
  "$INSTALL_DIR/exp-portable-restore.js"

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
