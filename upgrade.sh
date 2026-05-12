#!/usr/bin/env bash
# upgrade.sh — single entry point to refresh an existing Experience Engine
# install with the latest code from this repo. Auto-detects install mode
# from ~/.experience/config.json and delegates to the right script.
#
# Usage:
#   bash upgrade.sh              # pull latest + sync runtime, preserve config
#   bash upgrade.sh --no-pull    # skip git pull (use already-checked-out code)
#   bash upgrade.sh --dry-run    # print what would happen, change nothing
#   bash upgrade.sh --help
#
# Modes detected:
#   thin-client → delegates to .experience/setup-thin-client.sh (idempotent,
#                 preserves server URL, tokens, org, hook timeout)
#   full        → delegates to .experience/sync-install.sh (refreshes JS
#                 runtime + src modules, never touches config.json or store)
#   (no config) → prints a hint to run setup.sh for fresh install
#
# Anything after `--` is forwarded verbatim to the underlying script. Example
# to change the org binding while upgrading a thin client:
#   bash upgrade.sh -- --org-name acme --org-patterns "acme-*,legacy-app"

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_PATH="${HOME}/.experience/config.json"
DO_PULL=true
DRY_RUN=false
EXTRA_ARGS=()

# ── Arg parsing ─────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --no-pull) DO_PULL=false; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --) shift; EXTRA_ARGS+=("$@"); break ;;
    *)
      echo "[upgrade] Unknown option: $1" >&2
      echo "[upgrade] Run 'bash upgrade.sh --help' for usage." >&2
      exit 1
      ;;
  esac
done

step() { printf '\n[upgrade] %s\n' "$*"; }

# ── Step 1: git pull (optional) ────────────────────────────────────────────
if [ "$DO_PULL" = "true" ]; then
  if [ -d "$REPO_DIR/.git" ]; then
    step "Pulling latest from origin..."
    if [ "$DRY_RUN" = "true" ]; then
      echo "  (dry-run) git -C $REPO_DIR pull --ff-only"
    else
      git -C "$REPO_DIR" pull --ff-only
    fi
  else
    step "Not a git checkout — skipping pull. ($REPO_DIR has no .git)"
  fi
fi

# ── Step 2: Detect install mode from config ─────────────────────────────────
MODE="unknown"
if [ -f "$CONFIG_PATH" ]; then
  # Hard-require node before invoking it; otherwise `node -e` exit-non-zero is
  # swallowed under set -e and MODE becomes empty, hitting the catch-all `*)`
  # in the case statement with no useful error.
  if ! command -v node >/dev/null 2>&1; then
    echo "[upgrade] Node.js is required to detect install mode but was not found in PATH." >&2
    echo "[upgrade] Install Node.js 20+ and re-run: bash upgrade.sh" >&2
    exit 1
  fi
  if ! MODE=$(node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      if (typeof c.version !== 'string') { process.stdout.write('unknown'); return; }
      if (c.version === 'thin-client') process.stdout.write('thin-client');
      else process.stdout.write('full');
    } catch { process.stdout.write('unknown'); }
  " "$CONFIG_PATH" 2>/dev/null); then
    MODE="unknown"
  fi
  # Defensive: empty output under exotic setups should not propagate.
  if [ -z "${MODE:-}" ]; then MODE="unknown"; fi
else
  MODE="absent"
fi

step "Detected install mode: $MODE  (from $CONFIG_PATH)"

# ── Step 3: Delegate ────────────────────────────────────────────────────────
case "$MODE" in
  thin-client)
    DELEGATE="$REPO_DIR/.experience/setup-thin-client.sh"
    step "Refreshing thin-client runtime via setup-thin-client.sh"
    ;;
  full)
    DELEGATE="$REPO_DIR/.experience/sync-install.sh"
    step "Refreshing full-install runtime via sync-install.sh"
    ;;
  absent)
    cat <<EOF

[upgrade] No ~/.experience/config.json found — nothing to upgrade.
[upgrade] For a fresh install run:
[upgrade]   bash $REPO_DIR/.experience/setup.sh             # interactive wizard
[upgrade]   bash $REPO_DIR/.experience/setup-thin-client.sh --server <vps-url> \\
[upgrade]        --token <bearer>                            # thin-client to remote brain
EOF
    exit 1
    ;;
  *)
    echo "[upgrade] Could not parse $CONFIG_PATH — aborting." >&2
    exit 1
    ;;
esac

if [ ! -f "$DELEGATE" ]; then
  echo "[upgrade] Delegate script missing: $DELEGATE" >&2
  exit 1
fi

if [ "$DRY_RUN" = "true" ]; then
  printf '  (dry-run) bash %s' "$DELEGATE"
  for a in ${EXTRA_ARGS+"${EXTRA_ARGS[@]}"}; do printf ' %q' "$a"; done
  printf '\n'
  exit 0
fi

bash "$DELEGATE" ${EXTRA_ARGS+"${EXTRA_ARGS[@]}"}

step "Upgrade complete (mode=$MODE). Run health-check.sh if you want a full sanity pass."
