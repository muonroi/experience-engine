#!/bin/bash
set +H 2>/dev/null
# Experience Engine — Setup Router v4.0
#
# Default install paths (no embed/brain/Qdrant wizard):
#   [1] Thin client  → remote brain (setup-thin-client.sh)
#   [2] Docker       → local Qdrant + Ollama + API, then thin client @ :8082
#   [3] Node init    → cross-platform installer (bin/init.js)
#
# Advanced full-local brain (legacy wizard with embed/brain providers):
#   bash .experience/setup.sh --full
#   bash .experience/setup-full.sh
#
# Usage:
#   bash .experience/setup.sh                  # interactive menu (recommended)
#   bash .experience/setup.sh --thin-client      # thin client (prompts if needed)
#   bash .experience/setup.sh --docker           # docker compose + wire hooks
#   bash .experience/setup.sh --init [args]      # node bin/init.js
#   bash .experience/setup.sh --full [args]      # legacy full-local wizard
#   bash .experience/setup.sh --help

set -euo pipefail

INSTALL_DIR="${HOME}/.experience"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SRC_DIR/.." && pwd)"
CONFIG_FILE="${INSTALL_DIR}/config.json"

# ── WSL mismatch detection ─────────────────────────────────────────────────
if grep -qi microsoft /proc/version 2>/dev/null; then
  _SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)"
  if [[ "$_SCRIPT_PATH" == /mnt/* ]]; then
    if ! command -v node >/dev/null 2>&1; then
      echo ""
      echo "  [ERROR] Running in WSL but Node.js is not installed in WSL."
      echo ""
      echo "  Fix — choose one:"
      echo "    A. Install Node.js in WSL"
      echo "    B. From PowerShell:  & \"\$env:ProgramFiles\\Git\\bin\\bash.exe\" $0 $*"
      echo "    C. Open Git Bash terminal, then:  bash $0"
      echo ""
      exit 1
    fi
    echo ""
    echo "  [WSL] Running from WSL on Windows filesystem (/mnt/...)."
    echo "  Files install to WSL home (~), not Windows home."
    echo ""
  fi
fi

step() { printf '\n  %s\n' "$*"; }

probe_local_brain() {
  local url="${1:-http://localhost:8082}"
  node -e "
    const url = process.argv[1];
    fetch(url.replace(/\/$/, '') + '/health', { signal: AbortSignal.timeout(2000) })
      .then(r => r.json())
      .then(d => process.exit(d && d.status === 'ok' ? 0 : 1))
      .catch(() => process.exit(1));
  " "$url" 2>/dev/null
}

config_version() {
  [ -f "$CONFIG_FILE" ] || return 0
  node -e '
    try {
      const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (c.version === "thin-client") process.stdout.write("thin-client");
      else if (c.serverBaseUrl) process.stdout.write("thin-client");
      else process.stdout.write("full");
    } catch { process.stdout.write("unknown"); }
  ' "$CONFIG_FILE" 2>/dev/null
}

show_help() {
  cat <<'HELP'
Experience Engine — setup (router v4)

Recommended (most users):
  bash .experience/setup.sh
      Interactive menu — thin client, Docker, or cross-platform init.
      Does NOT ask for embed/brain API keys unless you pick --full.

  bash .experience/setup.sh --thin-client [--server URL] [--token TOKEN]
      Wire this machine as a thin client to a remote (or local) brain API.
      Prompts for URL + token on fresh install when flags are omitted.

  bash .experience/setup.sh --docker
      Start docker compose (Qdrant + Ollama + API on :8082), then wire hooks.

  bash .experience/setup.sh --init [args]
      Cross-platform installer (same as: npx @muonroi/experience-engine init).

Already installed:
  bash upgrade.sh              Refresh runtime from git (keeps config)
  bash ~/.experience/health-check.sh

Advanced — full local brain (legacy):
  bash .experience/setup.sh --full
  bash .experience/setup-full.sh
      Interactive wizard: Qdrant, embed provider, brain LLM, collections.
      Use only when you need a local experience-core.js brain without Docker.

Non-interactive full install (CI): set EXP_QDRANT_URL, EXP_EMBED_PROVIDER,
EXP_BRAIN_PROVIDER, EXP_EMBED_MODEL, EXP_BRAIN_MODEL — then run --full.
HELP
}

run_docker_install() {
  step "Docker Compose — local brain stack"
  if ! command -v docker >/dev/null 2>&1; then
    echo "  [FAIL] Docker not found. Install from https://docker.com"
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "  [FAIL] Docker daemon not running. Start Docker Desktop first."
    exit 1
  fi

  local compose_file="$ROOT_DIR/docker-compose.yml"
  if [ ! -f "$compose_file" ]; then
    echo "  [FAIL] docker-compose.yml not found at $compose_file"
    exit 1
  fi

  echo "  Starting Qdrant + Ollama + Experience Engine API..."
  (cd "$ROOT_DIR" && docker compose up -d)

  echo "  Waiting for http://localhost:8082/health ..."
  local i
  for i in $(seq 1 40); do
    if probe_local_brain "http://localhost:8082"; then
      echo "  ✓ Local brain is healthy"
      break
    fi
    if [ "$i" -eq 40 ]; then
      echo "  [WARN] Brain not healthy yet — wiring hooks anyway; check: docker compose logs"
    fi
    sleep 3
  done

  echo ""
  echo "  Wiring agent hooks to http://localhost:8082 ..."
  exec bash "$SRC_DIR/setup-thin-client.sh" --server "http://localhost:8082" --token ""
}

run_thin_client() {
  exec bash "$SRC_DIR/setup-thin-client.sh" "$@"
}

run_node_init() {
  shift || true
  if [ ! -f "$ROOT_DIR/bin/init.js" ]; then
    echo "  [FAIL] bin/init.js not found — run from the experience-engine repo,"
    echo "         or use: npx @muonroi/experience-engine init $*"
    exit 1
  fi
  exec node "$ROOT_DIR/bin/init.js" "$@"
}

run_full_wizard() {
  exec bash "$SRC_DIR/setup-full.sh" "$@"
}

handle_existing_config() {
  local ver
  ver="$(config_version)"
  [ -n "$ver" ] || return 0

  echo ""
  echo "  Existing install detected ($CONFIG_FILE)"
  echo "  Mode: $ver"
  echo ""
  if [ "$ver" = "thin-client" ]; then
    echo "  [1] Keep config — refresh runtime only (upgrade.sh)"
    echo "  [2] Reconfigure thin client (server URL / tokens)"
    echo "  [3] Advanced: switch to full local install (--full)"
    printf "  Choice [1/2/3]: "
    read -r choice
    case "${choice:-1}" in
      2) run_thin_client "$@" ;;
      3) run_full_wizard "$@" ;;
      *) exec bash "$ROOT_DIR/upgrade.sh" 2>/dev/null || exec bash "$SRC_DIR/sync-install.sh" ;;
    esac
  else
    echo "  [1] Keep config — refresh runtime (upgrade.sh / sync-install)"
    echo "  [2] Reconfigure full local brain (setup-full.sh)"
    echo "  [3] Switch to thin client (recommended)"
    printf "  Choice [1/2/3]: "
    read -r choice
    case "${choice:-1}" in
      2) run_full_wizard "$@" ;;
      3) run_thin_client "$@" ;;
      *) exec bash "$ROOT_DIR/upgrade.sh" 2>/dev/null || exec bash "$SRC_DIR/sync-install.sh" ;;
    esac
  fi
}

interactive_menu() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " Experience Engine — Setup"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " Install dir: $INSTALL_DIR"
  echo ""
  echo "  How do you want to use Experience Engine?"
  echo ""
  echo "  [1] Thin client (recommended)"
  echo "      Connect to a remote brain API — no embed/brain keys on this machine."
  echo "  [2] Local brain with Docker"
  echo "      docker compose up -d → API on http://localhost:8082"
  echo "  [3] Cross-platform init (Node.js)"
  echo "      Same as: npx @muonroi/experience-engine init"
  echo "  [4] Advanced: full local install"
  echo "      Legacy wizard — Qdrant + embed + brain providers (expert/CI)"
  echo ""
  printf "  Choice [1]: "
  read -r menu_choice
  menu_choice="${menu_choice:-1}"

  case "$menu_choice" in
    1)
      local server_url="" server_token="" read_token=""
      if probe_local_brain "http://localhost:8082"; then
        echo ""
        echo "  Local brain detected at http://localhost:8082"
        printf "  Use local brain? [Y/n]: "
        read -r use_local
        if [ "${use_local:-Y}" != "n" ] && [ "${use_local:-Y}" != "N" ]; then
          exec bash "$SRC_DIR/setup-thin-client.sh" --server "http://localhost:8082" --token ""
        fi
      fi
      printf "  Remote brain URL (e.g. https://experience.example.com): "
      read -r server_url
      [ -n "$server_url" ] || { echo "  [FAIL] Server URL is required."; exit 1; }
      printf "  Bearer token (POST endpoints): "
      read -r server_token
      [ -n "$server_token" ] || { echo "  [FAIL] Token is required for remote brains."; exit 1; }
      printf "  Read-only token (optional, Enter to skip): "
      read -r read_token
      local -a thin_args=(--server "$server_url" --token "$server_token")
      [ -n "$read_token" ] && thin_args+=(--read-token "$read_token")
      exec bash "$SRC_DIR/setup-thin-client.sh" "${thin_args[@]}"
      ;;
    2) run_docker_install ;;
    3) run_node_init "$@" ;;
    4) run_full_wizard "$@" ;;
    *)
      echo "  [FAIL] Invalid choice: $menu_choice"
      exit 1
      ;;
  esac
}

# ── Early routing ──────────────────────────────────────────────────────────
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  show_help
  exit 0
fi

for _arg in "$@"; do
  case "$_arg" in
    --full|--local) exec bash "$SRC_DIR/setup-full.sh" "$@" ;;
    --thin-client) shift; run_thin_client "$@" ;;
    --docker) run_docker_install ;;
    --init) shift; run_node_init "$@" ;;
  esac
done

# EXP_* vars → legacy non-interactive full install
if [ -n "${EXP_QDRANT_URL:-}" ] || [ -n "${EXP_EMBED_PROVIDER:-}" ] || [ -n "${EXP_BRAIN_PROVIDER:-}" ]; then
  exec bash "$SRC_DIR/setup-full.sh" "$@"
fi

# Existing config — offer upgrade / reconfigure instead of dropping into embed wizard
if [ -f "$CONFIG_FILE" ] && [ $# -eq 0 ]; then
  handle_existing_config "$@"
fi

# Fresh install — modern menu (no embed/brain prompts)
if [ $# -eq 0 ]; then
  interactive_menu "$@"
fi

# Unknown flags with args — pass through to thin-client or show help
echo "  [ERROR] Unknown option(s): $*"
echo "  Run: bash .experience/setup.sh --help"
exit 1