#!/bin/bash
set +H 2>/dev/null   # disable history expansion — fixes !res.ok in node -e blocks
# Experience Engine — Universal Setup Wizard v3.1
#
# Works from ANY project directory. Installs brain to ~/.experience/ (user-level).
# Global agent hooks point to ~/.experience/ — no project path hardcoded.
#
# Usage:
#   bash .experience/setup.sh               # interactive wizard (fresh install)
#   bash .experience/setup.sh --help        # show all options
#   bash .experience/setup.sh --local       # shortcut: local Docker Qdrant + Ollama
#   bash .experience/setup.sh --vps         # shortcut: VPS Qdrant via SSH tunnel
#
# Supported agents: Claude Code, Gemini CLI, Codex CLI, OpenCode
# Prerequisites: Node.js 20+

# ── WSL mismatch detection ─────────────────────────────────────────────────
# PowerShell's `bash` invokes WSL, not Git Bash. If the user intentionally
# runs from WSL (e.g., to set up Codex CLI), that's fine — as long as
# Node.js is available. Only block when WSL has no node (accidental invoke).
if grep -qi microsoft /proc/version 2>/dev/null; then
  _SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)"
  if [[ "$_SCRIPT_PATH" == /mnt/* ]]; then
    if ! command -v node &>/dev/null; then
      echo ""
      echo "  [ERROR] Running in WSL but Node.js is not installed in WSL."
      echo ""
      echo "  This usually means PowerShell's 'bash' invoked WSL accidentally."
      echo "  WSL needs its own Node.js to run setup correctly."
      echo ""
      echo "  Fix — choose one:"
      echo "    A. Install Node.js in WSL:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
      echo "    B. From PowerShell:  & \"\$env:ProgramFiles\\Git\\bin\\bash.exe\" $0 $*"
      echo "    C. Open Git Bash terminal, then:  bash $0"
      echo "    D. Use setup.ps1 wrapper:  powershell .experience\\setup.ps1"
      echo ""
      exit 1
    fi
    # WSL with node available — warn about install paths but allow
    echo ""
    echo "  [WSL] Running from WSL on Windows filesystem (/mnt/...)."
    echo "  Files will install to WSL home (~), not Windows home."
    echo "  This is correct for Codex CLI (hooks only work in WSL)."
    echo ""
  fi
fi

INSTALL_DIR="$HOME/.experience"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

# Cross-platform node stdout capture.
# MSYS/Git Bash "stdout is not a tty": native .exe (node) inside $() subshells
# triggers MSYS TTY detection errors. Fix: run node OUTSIDE $(), redirect stdout
# to temp file, then read with cat (POSIX tool — no TTY issue).
# Usage: _node_run [node args...] — sets _NR_OUT (stdout) and _NR_RC (exit code)
_NR_FILE="/tmp/_nrun_$$.out"
_node_run() {
  rm -f "$_NR_FILE"
  node "$@" > "$_NR_FILE" 2>"${_NR_ERR:-/dev/null}"
  _NR_RC=$?
  _NR_OUT=""
  [ -f "$_NR_FILE" ] && _NR_OUT=$(cat "$_NR_FILE")
  rm -f "$_NR_FILE"
}

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Experience Engine v1.0 — Setup Wizard"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Install dir: $INSTALL_DIR"
echo ""

# ── Step 0: --help flag ────────────────────────────────────────────────────
if [[ "$1" == "--help" || "$1" == "-h" ]]; then
  cat <<'HELP'
Usage: bash setup.sh [OPTIONS]

Options:
  --help, -h     Show this help message
  --docker       Docker Compose quick start (recommended — one command)
  --local        Shortcut: local Docker Qdrant + Ollama (manual Node.js setup)
  --vps          Shortcut: VPS Qdrant via SSH tunnel

Non-interactive mode (CI/scripts):
  Set ALL required EXP_* variables:
    EXP_QDRANT_URL       Qdrant server URL (e.g. http://localhost:6333)
    EXP_QDRANT_KEY       Qdrant API key (empty for local)
    EXP_EMBED_PROVIDER   ollama | openai | gemini | siliconflow | custom
    EXP_BRAIN_PROVIDER   ollama | openai | gemini | claude | deepseek | siliconflow | custom
    EXP_EMBED_MODEL      embedding model name
    EXP_BRAIN_MODEL      brain LLM model name
    EXP_EMBED_KEY        API key for embed provider (empty for ollama)
    EXP_BRAIN_KEY        API key for brain provider (empty for ollama)
    EXP_EMBED_ENDPOINT   custom embed endpoint URL (for siliconflow/custom)
    EXP_BRAIN_ENDPOINT   custom brain endpoint URL (for siliconflow/custom)
    EXP_BRAIN_PROXY      Optional proxy URL for brain API calls (firewall bypass)
                         Example: EXP_BRAIN_PROXY=http://your-vps:8082/api/brain
    EXP_TUNNEL_SSH       SSH tunnel command for VPS Qdrant (optional)
                         Example: EXP_TUNNEL_SSH="ssh -i ~/.ssh/key -f -N -L 6333:localhost:6333 user@host"
    EXP_OLLAMA_URL       Ollama URL (default: http://localhost:11434)
    EXP_AGENTS           comma-separated agent list (default: all)
                         values: claude,gemini,codex,opencode
                         example: EXP_AGENTS=claude,gemini

  Example:
    EXP_QDRANT_URL=http://localhost:6333 EXP_EMBED_PROVIDER=openai \
    EXP_EMBED_KEY=sk-... EXP_EMBED_MODEL=text-embedding-3-small \
    EXP_BRAIN_PROVIDER=openai EXP_BRAIN_KEY=sk-... \
    EXP_BRAIN_MODEL=gpt-4o-mini bash setup.sh

Reconfigure:
  Run setup.sh again and choose [2] Reconfigure.
HELP
  exit 0
fi

# ── Step 0.5: --docker flag ─────────────────────────────────────────────────
if [[ "$1" == "--docker" ]]; then
  echo ""
  echo "  Docker Compose Quick Start"
  echo "  ─────────────────────────────"
  echo ""

  # Check Docker
  if ! command -v docker &>/dev/null; then
    echo "  [FAIL] Docker not found. Install from https://docker.com"
    exit 1
  fi
  if ! docker info &>/dev/null; then
    echo "  [FAIL] Docker daemon not running. Start Docker Desktop first."
    exit 1
  fi

  # Find docker-compose.yml relative to this script
  COMPOSE_FILE="$SRC_DIR/../docker-compose.yml"
  if [ ! -f "$COMPOSE_FILE" ]; then
    # Try repo root
    COMPOSE_FILE="$(cd "$SRC_DIR/.." && pwd)/docker-compose.yml"
  fi
  if [ ! -f "$COMPOSE_FILE" ]; then
    echo "  [FAIL] docker-compose.yml not found."
    echo "  Run from the experience-engine repo root:"
    echo "    docker compose up -d"
    exit 1
  fi

  COMPOSE_DIR="$(dirname "$COMPOSE_FILE")"
  echo "  Starting Qdrant + Ollama + Experience Engine..."
  echo ""
  cd "$COMPOSE_DIR" && docker compose up -d
  RESULT=$?

  if [ $RESULT -eq 0 ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo " ✓ Experience Engine running!"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "  API:     http://localhost:8082"
    echo "  Health:  http://localhost:8082/health"
    echo "  Qdrant:  http://localhost:6333/dashboard"
    echo ""
    echo "  Test:    curl http://localhost:8082/health"
    echo "  Logs:    docker compose logs -f"
    echo "  Stop:    docker compose down"
    echo ""
    echo "  Note: Ollama is pulling models in background (~2GB)."
    echo "  Intercept may return empty results until models are ready."
    echo "  Check: docker compose logs ollama-init"
    echo ""

    # Wire agent hooks to point to Docker API
    echo "  Wire agent hooks? (hooks call localhost:8082 instead of local brain)"
    echo ""
    read -p "  Wire Claude Code hooks? [Y/n] " WIRE_CLAUDE
    if [[ "$WIRE_CLAUDE" != "n" && "$WIRE_CLAUDE" != "N" ]]; then
      # Copy hook files to ~/.experience/ so hooks can find them
      mkdir -p "$HOME/.experience"
      cp "$SRC_DIR/experience-core.js" "$HOME/.experience/" 2>/dev/null
      cp "$SRC_DIR/stop-extractor.js" "$HOME/.experience/" 2>/dev/null
      cp "$SRC_DIR/interceptor-post.js" "$HOME/.experience/" 2>/dev/null
      cp "$SRC_DIR/judge-worker.js" "$HOME/.experience/" 2>/dev/null

      # Write config pointing to Docker services
      cat > "$HOME/.experience/config.json" <<DOCKERCFG
{
  "qdrantUrl": "http://localhost:6333",
  "ollamaUrl": "http://localhost:11434",
  "embedProvider": "ollama",
  "brainProvider": "ollama",
  "embedModel": "nomic-embed-text",
  "brainModel": "qwen2.5:3b",
  "minConfidence": 0.42,
  "highConfidence": 0.60
}
DOCKERCFG
      echo "  ✓ Config written to ~/.experience/config.json"
      echo "  ✓ Hooks installed to ~/.experience/"
      echo ""
      echo "  Add to your Claude Code settings.json (hooks section):"
      echo '    "PreToolUse": [{"matcher":"Edit|Write|Bash","hooks":[{"type":"command","command":"node ~/.experience/experience-core.js","timeout":3}]}]'
      echo ""
    fi
  else
    echo ""
    echo "  [FAIL] Docker Compose failed. Check: docker compose logs"
    exit 1
  fi

  exit 0
fi

# ── Non-interactive detection (CI/scripts — ALL vars must be set) ──────────
NI_MODE=false
if [ -n "$EXP_QDRANT_URL" ] && [ -n "$EXP_EMBED_PROVIDER" ] && \
   [ -n "$EXP_BRAIN_PROVIDER" ] && [ -n "$EXP_EMBED_MODEL" ] && \
   [ -n "$EXP_BRAIN_MODEL" ]; then
  NI_MODE=true
  echo "  Non-interactive mode: all EXP_* vars provided"
elif [ -n "$EXP_QDRANT_URL" ] || [ -n "$EXP_EMBED_PROVIDER" ] || \
     [ -n "$EXP_BRAIN_PROVIDER" ]; then
  echo "  Warning: some EXP_* vars are set but not all required ones."
  echo "  Falling through to interactive mode."
  echo "  Required: EXP_QDRANT_URL, EXP_EMBED_PROVIDER, EXP_BRAIN_PROVIDER,"
  echo "            EXP_EMBED_MODEL, EXP_BRAIN_MODEL"
  echo ""
fi

# ── Shortcut flags ────────────────────────────────────────────────────────
if [[ "$1" == "--local" ]]; then
  NI_MODE=true
  EXP_QDRANT_URL="http://localhost:6333"
  EXP_QDRANT_KEY=""
  EXP_EMBED_PROVIDER="ollama"
  EXP_BRAIN_PROVIDER="ollama"
  EXP_EMBED_MODEL="nomic-embed-text"
  EXP_BRAIN_MODEL="qwen2.5:3b"
  EXP_OLLAMA_URL="http://localhost:11434"
  EXP_EMBED_KEY=""
  EXP_BRAIN_KEY=""
  EXP_EMBED_ENDPOINT=""
  EXP_BRAIN_ENDPOINT=""
  EXP_BRAIN_PROXY=""
  echo "  Shortcut --local: local Docker Qdrant + Ollama"
fi

CONFIG_FILE="$INSTALL_DIR/config.json"
KEEP_CONFIG=false

# ── Parse --remote flag ────────────────────────────────────────────────────
REMOTE_HOST=""
REMOTE_KEY=""
_ARGS=("$@")
for (( _i=0; _i<${#_ARGS[@]}; _i++ )); do
  if [ "${_ARGS[$_i]}" = "--remote" ]; then
    _j=$((_i+1)); REMOTE_HOST="${_ARGS[$_j]:-}"
    # Validate format: user@host or host (no shell metacharacters)
    if [[ -n "$REMOTE_HOST" ]] && ! [[ "$REMOTE_HOST" =~ ^[a-zA-Z0-9._@-]+$ ]]; then
      echo "  [ERROR] Invalid --remote value: '$REMOTE_HOST'. Use user@host format."
      exit 1
    fi
  fi
  if [ "${_ARGS[$_i]}" = "--key" ]; then
    _j=$((_i+1)); REMOTE_KEY="${_ARGS[$_j]:-}"
    # Validate key file exists
    if [ -n "$REMOTE_KEY" ] && [ ! -f "$REMOTE_KEY" ]; then
      echo "  [ERROR] --key file not found: '$REMOTE_KEY'"
      exit 1
    fi
  fi
done

# ── Step 1: Resolve config ─────────────────────────────────────────────────
echo "◆ [1/6] Resolving config..."

if [ -f "$CONFIG_FILE" ] && [ "$NI_MODE" = "false" ]; then
  echo ""
  echo "  Existing config found at $CONFIG_FILE"
  echo ""
  echo "  [1] Keep existing config (skip Steps A+B)"
  echo "  [2] Reconfigure from scratch"
  printf "  Choice [1/2]: "; read -r REUSE_CHOICE

  if [ "$REUSE_CHOICE" = "2" ]; then
    echo "  Starting fresh configuration..."
    KEEP_CONFIG=false
  else
    KEEP_CONFIG=true
    echo "  Loading and validating existing config..."

    # Load existing config fields
    _NR_ERR=/dev/stdout _node_run -e "
try {
  const fs=require('fs'), path=require('path'), os=require('os');
  const f=path.join(os.homedir(),'.experience','config.json');
  const c=JSON.parse(fs.readFileSync(f,'utf8'));
  const fields=[
    'QDRANT_URL='+  (c.qdrantUrl||''),
    'QDRANT_KEY='+  (c.qdrantKey||''),
    'OLLAMA_URL='+  (c.ollamaUrl||''),
    'TUNNEL_SSH='+  (c.tunnelSsh||''),
    'EMBED_PROVIDER='+(c.embedProvider||''),
    'BRAIN_PROVIDER='+(c.brainProvider||''),
    'EMBED_MODEL='+ (c.embedModel||''),
    'BRAIN_MODEL='+ (c.brainModel||''),
    'EMBED_ENDPOINT='+(c.embedEndpoint||''),
    'EMBED_KEY='+(c.embedKey||''),
    'BRAIN_ENDPOINT='+(c.brainEndpoint||''),
    'BRAIN_KEY='+(c.brainKey||''),
    'EMBED_DIM='+(c.embedDim||768),
  ];
  process.stdout.write(fields.join('\n')+'\n');
} catch(e) { process.stderr.write('LOAD_FAILED: '+e.message+'\n'); process.exit(1); }
"
    _LOAD_RESULT="$_NR_OUT"

    if echo "$_LOAD_RESULT" | grep -q "LOAD_FAILED"; then
      echo ""
      echo "  [FAIL] Cannot read existing config: $(echo "$_LOAD_RESULT" | grep LOAD_FAILED)"
      echo "  Fix:   Check $CONFIG_FILE is valid JSON"
      echo ""
      echo "  [1] Reconfigure from scratch"
      echo "  [2] Continue anyway (may fail)"
      printf "  Choice [1/2]: "; read -r FIX_CHOICE
      if [ "$FIX_CHOICE" = "1" ]; then
        KEEP_CONFIG=false
      else
        echo "  Continuing with partial config..."
      fi
    else
      while IFS='=' read -r key val; do
        [ -n "$key" ] && export "$key"="$val"
      done <<< "$_LOAD_RESULT"

      # Validate loaded config
      CONFIG_VALID=true
      VALIDATION_ISSUES=""

      # Check required fields exist
      if [ -z "$QDRANT_URL" ]; then
        VALIDATION_ISSUES="${VALIDATION_ISSUES}\n    - Missing: qdrantUrl"
        CONFIG_VALID=false
      fi
      if [ -z "$EMBED_PROVIDER" ]; then
        VALIDATION_ISSUES="${VALIDATION_ISSUES}\n    - Missing: embedProvider"
        CONFIG_VALID=false
      fi
      if [ -z "$BRAIN_PROVIDER" ]; then
        VALIDATION_ISSUES="${VALIDATION_ISSUES}\n    - Missing: brainProvider"
        CONFIG_VALID=false
      fi
      if [ -z "$EMBED_DIM" ] || [ "$EMBED_DIM" = "0" ]; then
        VALIDATION_ISSUES="${VALIDATION_ISSUES}\n    - Missing: embedDim"
        CONFIG_VALID=false
      fi

      # Check API keys for cloud providers
      if [ "$EMBED_PROVIDER" = "openai" ] && [ -z "$EMBED_KEY" ]; then
        VALIDATION_ISSUES="${VALIDATION_ISSUES}\n    - OpenAI embed selected but no embedKey found"
        CONFIG_VALID=false
      fi
      if [ "$EMBED_PROVIDER" = "gemini" ] && [ -z "$EMBED_KEY" ]; then
        VALIDATION_ISSUES="${VALIDATION_ISSUES}\n    - Gemini embed selected but no embedKey found"
        CONFIG_VALID=false
      fi
      if [ "$BRAIN_PROVIDER" = "claude" ] && [ -z "$BRAIN_KEY" ]; then
        VALIDATION_ISSUES="${VALIDATION_ISSUES}\n    - Claude brain selected but no brainKey found"
        CONFIG_VALID=false
      fi
      if [ "$BRAIN_PROVIDER" = "deepseek" ] && [ -z "$BRAIN_KEY" ]; then
        VALIDATION_ISSUES="${VALIDATION_ISSUES}\n    - DeepSeek brain selected but no brainKey found"
        CONFIG_VALID=false
      fi

      if [ "$CONFIG_VALID" = false ]; then
        echo ""
        echo "  Config has issues:"
        printf "$VALIDATION_ISSUES\n"
        echo ""
        echo "  [1] Reconfigure (pick new providers)"
        echo "  [2] Continue anyway"
        printf "  Choice [1/2]: "; read -r FIX_CHOICE
        if [ "$FIX_CHOICE" = "1" ]; then
          KEEP_CONFIG=false
          echo "  Reconfiguring..."
        else
          echo "  Continuing with existing config..."
        fi
      else
        echo "  Config valid — keeping existing"
      fi
    fi
  fi
fi

if [ "$NI_MODE" = "true" ]; then
  # Load all vars from EXP_* env vars
  QDRANT_URL="${EXP_QDRANT_URL}"
  QDRANT_KEY="${EXP_QDRANT_KEY:-}"
  EMBED_PROVIDER="${EXP_EMBED_PROVIDER}"
  BRAIN_PROVIDER="${EXP_BRAIN_PROVIDER}"
  EMBED_MODEL="${EXP_EMBED_MODEL}"
  BRAIN_MODEL="${EXP_BRAIN_MODEL}"
  EMBED_KEY="${EXP_EMBED_KEY:-}"
  BRAIN_KEY="${EXP_BRAIN_KEY:-}"
  EMBED_ENDPOINT="${EXP_EMBED_ENDPOINT:-}"
  BRAIN_ENDPOINT="${EXP_BRAIN_ENDPOINT:-}"
  BRAIN_PROXY_URL="${EXP_BRAIN_PROXY:-}"
  OLLAMA_URL="${EXP_OLLAMA_URL:-http://localhost:11434}"
  TUNNEL_SSH="${EXP_TUNNEL_SSH:-}"
  KEEP_CONFIG=false
  # Allow caller to bypass dimension probe by setting EXP_EMBED_DIM
  [ -n "${EXP_EMBED_DIM:-}" ] && EMBED_DIM="${EXP_EMBED_DIM}"
fi

# ── NI mode dimension probe (must run before config write) ───────────────
if [ "$NI_MODE" = "true" ] && [ -z "$EMBED_DIM" ]; then
  echo "  Probing embedding dimension from API..."
  _DIM_PROBE=$(mktemp /tmp/exp-dim-probe.XXXXXX.js)
  cat > "$_DIM_PROBE" <<JSEOF
(async () => {
  const provider = '$EMBED_PROVIDER';
  const model = '$EMBED_MODEL';
  const key = '$EMBED_KEY';
  const endpoint = '$EMBED_ENDPOINT';
  const ollamaUrl = '$OLLAMA_URL';
  const testInput = 'dimension probe test';
  try {
    let vec;
    if (provider === 'ollama') {
      const url = ollamaUrl || 'http://localhost:11434';
      const res = await fetch(url + '/api/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: testInput }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) { process.stderr.write('HTTP ' + res.status + '\\n'); process.exit(1); }
      const d = await res.json();
      vec = d.embeddings?.[0];
    } else if (provider === 'gemini') {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':embedContent?key=' + key, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { parts: [{ text: testInput }] } }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) { process.stderr.write('HTTP ' + res.status + '\\n'); process.exit(1); }
      const d = await res.json();
      vec = d.embedding?.values;
    } else {
      const ep = endpoint || 'https://api.openai.com/v1/embeddings';
      const res = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ model, input: testInput }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) { process.stderr.write('HTTP ' + res.status + '\\n'); process.exit(1); }
      const d = await res.json();
      vec = d.data?.[0]?.embedding;
    }
    if (!vec || vec.length === 0) { process.stderr.write('Empty embedding\\n'); process.exit(1); }
    process.stdout.write(String(vec.length));
  } catch(e) { process.stderr.write(e.message + '\\n'); process.exit(1); }
})();
JSEOF
  _NR_ERR=/tmp/exp-dim-err _node_run "$_DIM_PROBE"
  EMBED_DIM="$_NR_OUT"
  rm -f "$_DIM_PROBE"

  if [ $_NR_RC -ne 0 ] || [ -z "$EMBED_DIM" ]; then
    echo ""
    echo "  [WARN] Cannot probe embed dimension ($EMBED_PROVIDER / $EMBED_MODEL)"
    if [ -s /tmp/exp-dim-err ]; then
      echo "  Error: $(cat /tmp/exp-dim-err)"
    fi
    echo "  Common: SiliconFlow=2048, OpenAI=1536, Gemini/Ollama=768, VoyageAI=1024"
    echo "  Fix:   Set EXP_EMBED_DIM=<number> or verify API key/endpoint"
    exit 1
  fi
  echo "  Embed dimension: $EMBED_DIM (probed from API)"
fi

# ── Step A: Vector store selection ────────────────────────────────────────
if [ "$KEEP_CONFIG" = "false" ] && [ "$NI_MODE" = "false" ]; then
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " Step A — Vector Store"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "  Where should experience vectors be stored?"
  echo ""
  echo "  [1] Qdrant Cloud     cloud.qdrant.io — free tier available"
  echo "  [2] Local Docker     docker run qdrant/qdrant — needs Docker Desktop"
  echo "  [3] VPS via SSH      SSH tunnel to your server"
  echo ""
  printf "  Choice [1/2/3]: "; read -r STORE_CHOICE

  case "$STORE_CHOICE" in
    1)
      echo ""
      echo "  Get your free Qdrant Cloud cluster at: https://cloud.qdrant.io"
      echo "  New Cluster → copy Cluster URL + API key"
      echo ""
      printf "  Qdrant URL (https://xxx.qdrant.io): "; read -r QDRANT_URL
      printf "  Qdrant API key: "; read -r QDRANT_KEY
      TUNNEL_SSH=""
      ;;
    2)
      echo ""
      echo "  Checking Docker..."
      if ! docker ps >/dev/null 2>&1; then
        echo ""
        echo "  [FAIL] Docker is not running or not installed"
        echo "  Fix:   Start Docker Desktop, then re-run setup.sh"
        exit 1
      fi
      if docker ps | grep -q qdrant; then
        echo "  Qdrant container already running"
      else
        echo "  Starting Qdrant container..."
        if ! docker run -d --name qdrant -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant 2>/tmp/exp-docker-err; then
          echo ""
          echo "  [FAIL] Docker failed to start Qdrant"
          echo "  Error: $(tail -3 /tmp/exp-docker-err)"
          echo "  Fix:   Make sure Docker Desktop is running, then re-run setup.sh"
          exit 1
        fi
        sleep 2
      fi
      QDRANT_URL="http://localhost:6333"
      QDRANT_KEY=""
      TUNNEL_SSH=""
      echo "  Qdrant running at localhost:6333"
      ;;
    3)
      echo ""
      printf "  VPS user@host (e.g. user@203.0.113.10): "; read -r VPS_HOST
      printf "  SSH key path [~/.ssh/id_rsa]: "; read -r VPS_KEY
      VPS_KEY="${VPS_KEY:-$HOME/.ssh/id_rsa}"
      printf "  Remote Qdrant port [6333]: "; read -r VPS_PORT
      VPS_PORT="${VPS_PORT:-6333}"
      LOCAL_TUNNEL_PORT="16333"
      QDRANT_URL="http://localhost:$LOCAL_TUNNEL_PORT"
      TUNNEL_SSH="ssh -i $VPS_KEY -f -N -o ServerAliveInterval=60 -L ${LOCAL_TUNNEL_PORT}:localhost:${VPS_PORT} $VPS_HOST"
      printf "  Qdrant API key on VPS (empty if none): "; read -r QDRANT_KEY
      echo "  VPS tunnel configured (will start after install)"
      ;;
    *)
      echo ""
      echo "  [FAIL] Invalid choice: $STORE_CHOICE"
      echo "  Fix:   Re-run setup.sh and choose 1, 2, or 3"
      exit 1
      ;;
  esac
fi

# ── Step B: AI provider selection ────────────────────────────────────────
if [ "$KEEP_CONFIG" = "false" ] && [ "$NI_MODE" = "false" ]; then
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " Step B — AI Provider for Embeddings"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "  Which provider generates embedding vectors?"
  echo ""
  echo "  [1] Ollama       local, free — nomic-embed-text"
  echo "  [2] OpenAI       text-embedding-3-small / large"
  echo "  [3] Gemini       text-embedding-004"
  echo "  [4] VoyageAI     voyage-code-3 (code-optimized)"
  echo "  [5] SiliconFlow  Qwen3-Embedding — cheap + fast"
  echo "  [6] Custom       any OpenAI-compatible endpoint"
  echo ""
  printf "  Choice [1-6]: "; read -r EMBED_CHOICE

  case "$EMBED_CHOICE" in
    1)
      echo ""
      if ! command -v ollama >/dev/null 2>&1; then
        echo "  [FAIL] Ollama not found"
        echo "  Fix:   Install Ollama from https://ollama.ai then re-run setup.sh"
        exit 1
      fi
      OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
      printf "  Ollama URL [http://localhost:11434]: "; read -r _OURL
      [ -n "$_OURL" ] && OLLAMA_URL="$_OURL"
      printf "  Embed model [nomic-embed-text]: "; read -r EMBED_MODEL
      EMBED_MODEL="${EMBED_MODEL:-nomic-embed-text}"
      echo "  Pulling model $EMBED_MODEL..."
      if ! ollama pull "$EMBED_MODEL" 2>/tmp/exp-ollama-err; then
        echo "  [FAIL] Could not pull $EMBED_MODEL"
        echo "  Error: $(tail -3 /tmp/exp-ollama-err)"
        echo "  Fix:   Check Ollama is running and model name is correct"
        exit 1
      fi
      EMBED_PROVIDER="ollama"
      EMBED_KEY=""
      EMBED_ENDPOINT=""
      ;;
    2)
      echo ""
      echo "  Get your API key at: https://platform.openai.com/api-keys"
      printf "  OpenAI API key (sk-...): "; read -r EMBED_KEY
      printf "  Embed model [text-embedding-3-small]: "; read -r EMBED_MODEL
      EMBED_MODEL="${EMBED_MODEL:-text-embedding-3-small}"
      EMBED_PROVIDER="openai"
      EMBED_ENDPOINT="https://api.openai.com/v1/embeddings"
      ;;
    3)
      echo ""
      echo "  Get your API key at: https://aistudio.google.com/apikey"
      printf "  Gemini API key (AIza...): "; read -r EMBED_KEY
      printf "  Embed model [text-embedding-004]: "; read -r EMBED_MODEL
      EMBED_MODEL="${EMBED_MODEL:-text-embedding-004}"
      EMBED_PROVIDER="gemini"
      EMBED_ENDPOINT=""
      ;;
    4)
      echo ""
      echo "  Get your API key at: https://www.voyageai.com"
      printf "  VoyageAI API key: "; read -r EMBED_KEY
      printf "  Embed model [voyage-code-3]: "; read -r EMBED_MODEL
      EMBED_MODEL="${EMBED_MODEL:-voyage-code-3}"
      EMBED_PROVIDER="openai"
      EMBED_ENDPOINT="https://api.voyageai.com/v1/embeddings"
      ;;
    5)
      echo ""
      echo "  Get your API key at: https://siliconflow.com"
      printf "  SiliconFlow API key (sk-...): "; read -r EMBED_KEY
      printf "  Embed model [Qwen/Qwen3-Embedding-0.6B]: "; read -r EMBED_MODEL
      EMBED_MODEL="${EMBED_MODEL:-Qwen/Qwen3-Embedding-0.6B}"
      EMBED_PROVIDER="siliconflow"
      EMBED_ENDPOINT="https://api.siliconflow.com/v1/embeddings"
      ;;
    6)
      echo ""
      echo "  Any OpenAI-compatible embedding API"
      printf "  Embeddings endpoint URL: "; read -r EMBED_ENDPOINT
      printf "  API key: "; read -r EMBED_KEY
      printf "  Embed model name: "; read -r EMBED_MODEL
      EMBED_PROVIDER="custom"
      ;;
    *)
      echo ""
      echo "  [FAIL] Invalid choice: $EMBED_CHOICE"
      exit 1
      ;;
  esac

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " Step B (cont.) — AI Provider for Brain (LLM Reasoning)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "  Which LLM analyzes sessions and extracts lessons?"
  echo ""
  echo "  [1] Ollama       local, free — qwen2.5:3b"
  echo "  [2] OpenAI       gpt-4o-mini"
  echo "  [3] Gemini       gemini-2.0-flash"
  echo "  [4] Claude       claude-haiku"
  echo "  [5] DeepSeek     deepseek-chat — cheapest direct API"
  echo "  [6] SiliconFlow  Qwen2.5 — cheap + fast"
  echo "  [7] Custom       any OpenAI-compatible endpoint"
  echo ""
  printf "  Choice [1-7]: "; read -r BRAIN_CHOICE

  case "$BRAIN_CHOICE" in
    1)
      echo ""
      OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
      if ! command -v ollama >/dev/null 2>&1; then
        echo "  [FAIL] Ollama not found"
        echo "  Fix:   Install Ollama from https://ollama.ai then re-run setup.sh"
        exit 1
      fi
      printf "  Brain model [qwen2.5:3b]: "; read -r BRAIN_MODEL
      BRAIN_MODEL="${BRAIN_MODEL:-qwen2.5:3b}"
      echo "  Pulling model $BRAIN_MODEL..."
      if ! ollama pull "$BRAIN_MODEL" 2>/tmp/exp-ollama-err; then
        echo "  [FAIL] Could not pull $BRAIN_MODEL"
        echo "  Error: $(tail -3 /tmp/exp-ollama-err)"
        echo "  Fix:   Check Ollama is running and model name is correct"
        exit 1
      fi
      BRAIN_PROVIDER="ollama"
      BRAIN_KEY=""
      BRAIN_ENDPOINT=""
      ;;
    2)
      echo ""
      echo "  Get your API key at: https://platform.openai.com/api-keys"
      printf "  OpenAI API key (sk-...): "; read -r BRAIN_KEY
      printf "  Brain model [gpt-4o-mini]: "; read -r BRAIN_MODEL
      BRAIN_MODEL="${BRAIN_MODEL:-gpt-4o-mini}"
      BRAIN_PROVIDER="openai"
      BRAIN_ENDPOINT="https://api.openai.com/v1/chat/completions"
      ;;
    3)
      echo ""
      echo "  Get your API key at: https://aistudio.google.com/apikey"
      printf "  Gemini API key (AIza...): "; read -r BRAIN_KEY
      printf "  Brain model [gemini-2.0-flash]: "; read -r BRAIN_MODEL
      BRAIN_MODEL="${BRAIN_MODEL:-gemini-2.0-flash}"
      BRAIN_PROVIDER="gemini"
      BRAIN_ENDPOINT=""
      ;;
    4)
      echo ""
      echo "  Get your API key at: https://console.anthropic.com/settings/keys"
      printf "  Anthropic API key (sk-ant-...): "; read -r BRAIN_KEY
      printf "  Brain model [claude-haiku-4-5]: "; read -r BRAIN_MODEL
      BRAIN_MODEL="${BRAIN_MODEL:-claude-haiku-4-5}"
      BRAIN_PROVIDER="claude"
      BRAIN_ENDPOINT=""
      ;;
    5)
      echo ""
      echo "  Get your API key at: https://platform.deepseek.com/api_keys"
      printf "  DeepSeek API key: "; read -r BRAIN_KEY
      printf "  Brain model [deepseek-chat]: "; read -r BRAIN_MODEL
      BRAIN_MODEL="${BRAIN_MODEL:-deepseek-chat}"
      BRAIN_PROVIDER="deepseek"
      BRAIN_ENDPOINT="https://api.deepseek.com/v1/chat/completions"
      ;;
    6)
      echo ""
      echo "  Get your API key at: https://siliconflow.com"
      printf "  SiliconFlow API key (sk-...): "; read -r BRAIN_KEY
      printf "  Brain model [Qwen/Qwen2.5-7B-Instruct]: "; read -r BRAIN_MODEL
      BRAIN_MODEL="${BRAIN_MODEL:-Qwen/Qwen2.5-7B-Instruct}"
      BRAIN_PROVIDER="siliconflow"
      BRAIN_ENDPOINT="https://api.siliconflow.com/v1/chat/completions"
      ;;
    7)
      echo ""
      echo "  Any OpenAI-compatible chat completions API"
      printf "  Chat completions URL: "; read -r BRAIN_ENDPOINT
      printf "  API key: "; read -r BRAIN_KEY
      printf "  Model name: "; read -r BRAIN_MODEL
      BRAIN_PROVIDER="custom"
      ;;
    *)
      echo ""
      echo "  [FAIL] Invalid choice: $BRAIN_CHOICE"
      exit 1
      ;;
  esac

  # ── Brain proxy URL (optional — firewall bypass) ─────────────────────────
  echo ""
  echo "  Brain proxy URL (optional — leave empty if not needed):"
  echo "  Used when local brain API is unreachable (firewall, corporate network)"
  echo "  Example: http://your-vps:8082/api/brain"
  printf "  Proxy URL [none]: "; read -r BRAIN_PROXY_URL
  BRAIN_PROXY_URL="${BRAIN_PROXY_URL:-}"

  # ── Dimension probe (after Step B) ──────────────────────────────────────
  echo ""
  echo "  Probing embedding dimension from API..."

  _DIM_PROBE=$(mktemp /tmp/exp-dim-probe.XXXXXX.js)
  cat > "$_DIM_PROBE" <<JSEOF
(async () => {
  const provider = '$EMBED_PROVIDER';
  const model = '$EMBED_MODEL';
  const key = '$EMBED_KEY';
  const endpoint = '$EMBED_ENDPOINT';
  const ollamaUrl = '$OLLAMA_URL';
  const testInput = 'dimension probe test';

  try {
    let vec;
    if (provider === 'ollama') {
      const url = ollamaUrl || 'http://localhost:11434';
      const res = await fetch(url + '/api/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: testInput }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        process.stderr.write('HTTP ' + res.status + ' from ' + url + '\\n');
        process.exit(1);
      }
      const d = await res.json();
      vec = d.embeddings?.[0];
    } else if (provider === 'gemini') {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':embedContent?key=' + key, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { parts: [{ text: testInput }] } }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const err = await res.text().catch(()=>'');
        process.stderr.write('HTTP ' + res.status + ': ' + err.slice(0,200) + '\\n');
        process.exit(1);
      }
      const d = await res.json();
      vec = d.embedding?.values;
    } else {
      // openai / siliconflow / custom / voyageai
      const ep = endpoint || 'https://api.openai.com/v1/embeddings';
      const res = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ model, input: testInput }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const err = await res.text().catch(()=>'');
        process.stderr.write('HTTP ' + res.status + ': ' + err.slice(0,200) + '\\n');
        process.exit(1);
      }
      const d = await res.json();
      vec = d.data?.[0]?.embedding;
    }
    if (!vec || vec.length === 0) {
      process.stderr.write('Empty embedding response\\n');
      process.exit(1);
    }
    process.stdout.write(String(vec.length));
  } catch(e) {
    process.stderr.write(e.message + '\\n');
    process.exit(1);
  }
})();
JSEOF
  _NR_ERR=/tmp/exp-dim-err _node_run "$_DIM_PROBE"
  EMBED_DIM="$_NR_OUT"
  rm -f "$_DIM_PROBE"

  if [ $_NR_RC -ne 0 ] || [ -z "$EMBED_DIM" ]; then
    echo ""
    echo "  [WARN] Cannot reach embed API ($EMBED_PROVIDER / $EMBED_MODEL)"
    if [ -s /tmp/exp-dim-err ]; then
      echo "  Error: $(cat /tmp/exp-dim-err)"
    fi
    echo ""
    echo "  Common dimensions by provider:"
    echo "    SiliconFlow (Qwen3-Embedding-0.6B): 2048"
    echo "    SiliconFlow (BAAI/bge-m3):          1024"
    echo "    OpenAI (text-embedding-3-small):     1536"
    echo "    Gemini (text-embedding-004):         768"
    echo "    Ollama (nomic-embed-text):           768"
    echo "    VoyageAI (voyage-code-3):            1024"
    if [ "$NI_MODE" = "true" ]; then
      echo ""
      echo "  Fix: Set EXP_EMBED_DIM=<number> (e.g. EXP_EMBED_DIM=2048)"
      exit 1
    else
      printf "  Enter dimension manually (or Ctrl+C to abort): "; read -r EMBED_DIM
      if [ -z "$EMBED_DIM" ] || ! echo "$EMBED_DIM" | grep -qE '^[0-9]+$'; then
        echo "  [FAIL] Invalid dimension. Re-run setup.sh with working API or set EXP_EMBED_DIM."
        exit 1
      fi
      echo "  Using manual dimension: $EMBED_DIM"
    fi
  else
    echo "  Embed dimension: $EMBED_DIM (probed from API)"
  fi
fi

# ── Step C: Optional seed ─────────────────────────────────────────────────
DO_SEED=false
SEED_DIR=""
if [ "$NI_MODE" = "false" ]; then
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " Step C (optional) — Bootstrap brain from existing memory rules?"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "  This seeds your experience brain from feedback_*.md files"
  echo "  in your ~/.claude/memory/ or similar directory."
  echo ""
  printf "  Path to memory dir (Enter to skip): "; read -r SEED_PATH
  if [ -n "$SEED_PATH" ]; then
    if [ -d "$SEED_PATH" ]; then
      DO_SEED=true
      SEED_DIR="$SEED_PATH"
      echo "  Will seed from: $SEED_DIR"
    else
      echo "  Warning: $SEED_PATH is not a directory — skipping seed"
    fi
  else
    echo "  Seed skipped"
  fi
fi

# ── Install step ──────────────────────────────────────────────────────────
echo ""
echo "◆ [2/6] Installing to $INSTALL_DIR..."

mkdir -p "$INSTALL_DIR"

# Copy core files — source is always canonical
if ! cp "$SRC_DIR/experience-core.js" "$INSTALL_DIR/experience-core.js"; then
  echo ""
  echo "  [FAIL] Could not copy experience-core.js"
  echo "  Error: source=$SRC_DIR/experience-core.js"
  echo "  Fix:   Make sure you're running setup.sh from the experience-engine directory"
  exit 1
fi

# Write wrapper hook: interceptor.js
cat > "$INSTALL_DIR/interceptor.js" << 'HOOKEOF'
#!/usr/bin/env node
'use strict';
const { intercept } = require(require('os').homedir() + '/.experience/experience-core.js');
let input = '';
const t = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', async () => {
  clearTimeout(t);
  try {
    const data = JSON.parse(input);
    const tool = data.tool_name || data.toolName || '';
    if (!tool.match(/Edit|Write|Bash|shell|replace|write_file|execute_command/i)) process.exit(0);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const result = await intercept(tool, data.tool_input || data.input || {}, ctrl.signal);
    clearTimeout(timer);
    if (result) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', additionalContext: result }
      }));
    }
  } catch {}
  process.exit(0);
});
HOOKEOF

# Write wrapper hook: stop-extractor.js
cat > "$INSTALL_DIR/stop-extractor.js" << 'HOOKEOF'
#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path');
const home = require('os').homedir();
const { extractFromSession } = require(home + '/.experience/experience-core.js');
const MARKER = home + '/.experience/.stop-marker.json';
const MIN_NEW_LINES = 8;
async function main() {
  const log = findCurrentSession();
  if (!log) return;
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  let marker = {};
  try { marker = JSON.parse(fs.readFileSync(MARKER, 'utf8')); } catch {}
  const start = marker.file === log ? (marker.line || 0) : 0;
  const newLines = lines.slice(start);
  if (newLines.length < MIN_NEW_LINES) return;
  const transcript = newLines.map(l => { try { const e = JSON.parse(l); const c = e.content || e.message || ''; return typeof c === 'string' ? c.slice(0, 300) : ''; } catch { return ''; } }).filter(Boolean).join('\n');
  const count = await extractFromSession(transcript);
  fs.writeFileSync(MARKER, JSON.stringify({ file: log, line: lines.length }));
  if (count > 0) process.stderr.write('Experience: +' + count + ' lessons\n');
  try {
    const evolveMarker = home + '/.experience/.evolve-marker';
    let lastEvolve = 0;
    try { lastEvolve = JSON.parse(fs.readFileSync(evolveMarker, 'utf8')).ts || 0; } catch {}
    if (Date.now() - lastEvolve > 86400000) {
      const { evolve } = require(home + '/.experience/experience-core.js');
      const r = await evolve();
      fs.writeFileSync(evolveMarker, JSON.stringify({ ts: Date.now() }));
      const total = r.promoted + r.abstracted + r.demoted + r.archived;
      if (total > 0) process.stderr.write('Evolution: +' + r.promoted + ' promoted, ' + r.abstracted + ' abstracted, ' + r.demoted + ' demoted, ' + r.archived + ' archived\n');
    }
  } catch {}
}
function findCurrentSession() {
  const dir = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(dir)) return null;
  let latest = null, t = 0;
  const walk = d => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith('.jsonl') && fs.statSync(f).mtimeMs > t) { t = fs.statSync(f).mtimeMs; latest = f; } } } catch {} };
  walk(dir);
  return latest && (Date.now() - t) < 600000 ? latest : null;
}
main().catch(() => {}).finally(() => process.exit(0));
HOOKEOF

# Copy interceptor-post.js (PostToolUse feedback hook)
if [ -f "$SRC_DIR/interceptor-post.js" ]; then
  cp "$SRC_DIR/interceptor-post.js" "$INSTALL_DIR/interceptor-post.js"
fi

# Copy judge-worker.js (async LLM judge spawned by interceptor-post.js)
if [ -f "$SRC_DIR/judge-worker.js" ]; then
  cp "$SRC_DIR/judge-worker.js" "$INSTALL_DIR/judge-worker.js"
fi

chmod +x "$INSTALL_DIR/interceptor.js" "$INSTALL_DIR/stop-extractor.js" "$INSTALL_DIR/interceptor-post.js" "$INSTALL_DIR/judge-worker.js" 2>/dev/null

# Atomic config write — only when NOT keeping config
if [ "$KEEP_CONFIG" = "false" ]; then
  echo "  Writing config.json..."

  node -e "
const fs = require('fs');
const path = require('path');
const cfg = {
  qdrantUrl:      '$QDRANT_URL',
  qdrantKey:      '$QDRANT_KEY',
  embedProvider:  '$EMBED_PROVIDER',
  brainProvider:  '$BRAIN_PROVIDER',
  embedModel:     '$EMBED_MODEL',
  brainModel:     '$BRAIN_MODEL',
  embedEndpoint:  '$EMBED_ENDPOINT',
  embedKey:       '$EMBED_KEY',
  brainEndpoint:  '$BRAIN_ENDPOINT',
  brainKey:       '$BRAIN_KEY',
  brainProxyUrl:  '${BRAIN_PROXY_URL:-}',
  embedDim:       $EMBED_DIM,
  ollamaUrl:      '$OLLAMA_URL',
  tunnelSsh:      '$TUNNEL_SSH',
  minConfidence:  0.42,
  highConfidence: 0.60,
  version:        '3.2',
  installedAt:    new Date().toISOString()
};
const target = path.join(require('os').homedir(), '.experience', 'config.json');
const tmp = target + '.tmp';
try {
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, target);
  console.log('  Config written: ' + target);
} catch(e) {
  process.stderr.write('[FAIL] Could not write config: ' + e.message + '\n');
  process.exit(1);
}
"
  if [ $? -ne 0 ]; then
    echo ""
    echo "  [FAIL] Config write failed — aborting"
    exit 1
  fi
else
  echo "  Config preserved (keep mode — no rewrite)"
fi

echo "  Installed: $INSTALL_DIR/"

# ── Step 3 (was Step 3): Start SSH tunnel ────────────────────────────────
echo ""
echo "◆ [3/6] SSH tunnel..."
if [ -n "$TUNNEL_SSH" ]; then
  if curl -s -m 2 "$QDRANT_URL/collections" >/dev/null 2>&1; then
    echo "  Tunnel already active"
  else
    echo "  Starting tunnel..."
    if ! eval "$TUNNEL_SSH" 2>/tmp/exp-tunnel-err; then
      echo ""
      echo "  [FAIL] SSH tunnel failed to start"
      echo "  Error: $(tail -3 /tmp/exp-tunnel-err)"
      echo "  Fix:   Check SSH key path and VPS host are correct"
      exit 1
    fi
    sleep 2
    if curl -s -m 3 "$QDRANT_URL/collections" >/dev/null 2>&1; then
      echo "  Tunnel started — Qdrant reachable at $QDRANT_URL"
    else
      echo "  Warning: Tunnel started but Qdrant not responding at $QDRANT_URL"
      echo "           Check that Qdrant is running on the VPS"
    fi
  fi

  # Auto-start on boot
  OS=$(uname -s 2>/dev/null || echo "Windows")
  case "$OS" in
    MINGW*|MSYS*|CYGWIN*|Windows*)
      STARTUP="$APPDATA/Microsoft/Windows/Start Menu/Programs/Startup/experience-tunnel.vbs"
      printf "Set WshShell = CreateObject(\"WScript.Shell\")\nWshShell.Run \"%s\", 0, False\n" "$TUNNEL_SSH" > "$STARTUP"
      echo "  Auto-start: Windows startup script"
      ;;
    Darwin*)
      PLIST="$HOME/Library/LaunchAgents/com.experience-engine.tunnel.plist"
      SSH_ARGS=$(echo "$TUNNEL_SSH" | sed 's/^ssh //')
      cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.experience-engine.tunnel</string>
  <key>ProgramArguments</key><array><string>ssh</string>$(echo $SSH_ARGS | xargs -n1 echo | sed 's/.*/<string>&<\/string>/')</array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
EOF
      launchctl load "$PLIST" 2>/dev/null
      echo "  Auto-start: macOS LaunchAgent"
      ;;
    Linux*)
      # Detect WSL: Windows SSH tunnel on localhost is NOT reachable from WSL2
      IS_WSL=false
      if grep -qi microsoft /proc/version 2>/dev/null; then
        IS_WSL=true
      fi

      if [ "$IS_WSL" = "true" ]; then
        # WSL: Copy SSH key with correct permissions if needed
        WIN_KEY=$(echo "$TUNNEL_SSH" | grep -oP '(?<=-i )\S+')
        if [ -n "$WIN_KEY" ] && [[ "$WIN_KEY" == /mnt/* ]]; then
          WSL_KEY="$HOME/.ssh/$(basename "$WIN_KEY")"
          if [ ! -f "$WSL_KEY" ] || [ "$(stat -c %a "$WSL_KEY" 2>/dev/null)" != "600" ]; then
            mkdir -p "$HOME/.ssh"
            cp "$WIN_KEY" "$WSL_KEY"
            chmod 600 "$WSL_KEY"
            echo "  Copied SSH key to WSL: $WSL_KEY (chmod 600)"
          fi
          # Rewrite tunnel command with WSL key path
          TUNNEL_SSH=$(echo "$TUNNEL_SSH" | sed "s|$WIN_KEY|$WSL_KEY|g")
        fi

        # WSL: Add tunnel auto-start to .bashrc (idempotent)
        if ! grep -q "experience-engine-tunnel" "$HOME/.bashrc" 2>/dev/null; then
          cat >> "$HOME/.bashrc" << BASHEOF

# Experience Engine SSH tunnel auto-start (WSL)
pgrep -f "ssh.*$(echo "$TUNNEL_SSH" | grep -oP '\d+:localhost:\d+')" >/dev/null 2>&1 || $TUNNEL_SSH 2>/dev/null
BASHEOF
          echo "  Auto-start: WSL .bashrc (runs on each shell open)"
        else
          echo "  Auto-start: already in .bashrc"
        fi

        # WSL: Symlink ~/.experience to Windows files (shared brain)
        WIN_EXP="/mnt/c/Users/$(whoami 2>/dev/null || echo $USER)/.experience"
        if [ -d "$WIN_EXP" ] && [ ! -L "$HOME/.experience" ]; then
          if [ -d "$HOME/.experience" ] && [ ! -L "$HOME/.experience" ]; then
            echo "  ~/.experience exists as directory — skipping symlink"
          else
            ln -sf "$WIN_EXP" "$HOME/.experience"
            echo "  Symlinked ~/.experience → $WIN_EXP (shared with Windows agents)"
          fi
        fi
      else
        # Native Linux: systemd service
        SERVICE="$HOME/.config/systemd/user/experience-engine-tunnel.service"
        mkdir -p "$(dirname "$SERVICE")"
        printf "[Unit]\nDescription=Experience Engine Tunnel\nAfter=network.target\n[Service]\nExecStart=%s\nRestart=always\n[Install]\nWantedBy=default.target\n" "$TUNNEL_SSH" > "$SERVICE"
        systemctl --user daemon-reload && systemctl --user enable --now experience-engine-tunnel.service 2>/dev/null
        echo "  Auto-start: systemd service"
      fi
      ;;
  esac
else
  echo "  No tunnel needed (local or cloud Qdrant)"
fi

# ── Step 4: Verify Qdrant collections ────────────────────────────────────
echo ""
echo "◆ [4/6] Verifying Qdrant collections..."

# Load embedDim from written config (handles both keep and new paths)
_node_run -e "
try {
  const c=JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.experience/config.json','utf8'));
  process.stdout.write(String(c.embedDim||768));
} catch(e) {
  process.stderr.write('Cannot read config: '+e.message+'\n');
  process.stdout.write('768');
}"
EMBED_DIM="$_NR_OUT"

QDRANT_AUTH_HEADER=""
[ -n "$QDRANT_KEY" ] && QDRANT_AUTH_HEADER="-H \"api-key: $QDRANT_KEY\""

# Load QDRANT_URL from config if not set (keep mode)
if [ -z "$QDRANT_URL" ]; then
  _node_run -e "try{const c=JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.experience/config.json','utf8'));process.stdout.write(c.qdrantUrl||'http://localhost:6333')}catch{process.stdout.write('http://localhost:6333')}"
  QDRANT_URL="$_NR_OUT"
fi

for COLL in experience-principles experience-behavioral experience-selfqa experience-routes; do
  COLL_INFO=$(eval "curl -s -m 5 $QDRANT_AUTH_HEADER '$QDRANT_URL/collections/$COLL'" 2>/dev/null)
  _npi="/tmp/_npipe_$$.out"
  echo "$COLL_INFO" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);require('fs').writeFileSync('$_npi',j.result?.status||'')}catch{require('fs').writeFileSync('$_npi','')}})" 2>/dev/null
  STATUS=""; [ -f "$_npi" ] && STATUS=$(cat "$_npi")
  echo "$COLL_INFO" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);require('fs').writeFileSync('$_npi',String(j.result?.config?.params?.vectors?.size||0))}catch{require('fs').writeFileSync('$_npi','0')}})" 2>/dev/null
  CURRENT_DIM="0"; [ -f "$_npi" ] && CURRENT_DIM=$(cat "$_npi")
  rm -f "$_npi"

  if [ "$STATUS" = "green" ] || [ "$STATUS" = "yellow" ]; then
    if [ -n "$CURRENT_DIM" ] && [ "$CURRENT_DIM" != "0" ] && [ "$CURRENT_DIM" != "$EMBED_DIM" ]; then
      echo "  Warning: $COLL dimension mismatch: have ${CURRENT_DIM}, need ${EMBED_DIM} — recreating..."
      if ! eval "curl -s -m 10 -X DELETE $QDRANT_AUTH_HEADER '$QDRANT_URL/collections/$COLL'" >/dev/null 2>&1; then
        echo "  [FAIL] Could not delete $COLL for recreation"
        echo "  Fix:   Check Qdrant is accessible at $QDRANT_URL"
        exit 1
      fi
      if ! eval "curl -s -m 10 -X PUT $QDRANT_AUTH_HEADER '$QDRANT_URL/collections/$COLL' \
        -H 'Content-Type: application/json' \
        -d '{\"vectors\":{\"size\":${EMBED_DIM},\"distance\":\"Cosine\"}}'" >/dev/null 2>&1; then
        echo "  [WARN] Could not recreate $COLL (dim=$EMBED_DIM) — FileStore fallback will be used"
      fi
      echo "  $COLL recreated (dim=$EMBED_DIM)"
    else
      echo "  $COLL exists (dim=$CURRENT_DIM)"
    fi
  else
    if ! eval "curl -s -m 10 -X PUT $QDRANT_AUTH_HEADER '$QDRANT_URL/collections/$COLL' \
      -H 'Content-Type: application/json' \
      -d '{\"vectors\":{\"size\":${EMBED_DIM},\"distance\":\"Cosine\"}}'" >/dev/null 2>&1; then
      echo "  [WARN] Could not create collection $COLL — FileStore fallback will be used"
      echo "  Fix:   Start Qdrant at $QDRANT_URL, then re-run setup.sh"
    fi
    echo "  $COLL created (dim=$EMBED_DIM)"
  fi
done

# ── Step 5: Agent selection + Patch global agent settings ─────────────────
echo ""

# Determine which agents to patch
SELECTED_AGENTS=""
if [ -n "$EXP_AGENTS" ]; then
  # Non-interactive: use EXP_AGENTS env var
  SELECTED_AGENTS="$EXP_AGENTS"
  echo "◆ [5/6] Patching agent settings (EXP_AGENTS=$SELECTED_AGENTS)..."
elif [ "$NI_MODE" = "true" ]; then
  # Non-interactive without EXP_AGENTS: patch all (backward compatible)
  SELECTED_AGENTS="claude,gemini,codex,opencode"
  echo "◆ [5/6] Patching all agent settings (non-interactive default)..."
else
  # Interactive: ask user which agents to patch
  echo "◆ [5/6] Select AI agents to wire up..."
  echo ""
  echo "  Which agents do you use? (comma-separated numbers, or 'a' for all)"
  echo ""
  echo "  [1] Claude Code    ~/.claude/settings.json"
  echo "  [2] Gemini CLI     ~/.gemini/settings.json"
  echo "  [3] Codex CLI      ~/.codex/hooks.json"
  echo "  [4] OpenCode       ~/.config/opencode/config.json"
  echo ""
  printf "  Select [a]: "; read -r AGENT_CHOICE
  AGENT_CHOICE="${AGENT_CHOICE:-a}"

  if [ "$AGENT_CHOICE" = "a" ] || [ "$AGENT_CHOICE" = "A" ]; then
    SELECTED_AGENTS="claude,gemini,codex,opencode"
  else
    SELECTED_AGENTS=""
    case "$AGENT_CHOICE" in *1*) SELECTED_AGENTS="${SELECTED_AGENTS}claude,";; esac
    case "$AGENT_CHOICE" in *2*) SELECTED_AGENTS="${SELECTED_AGENTS}gemini,";; esac
    case "$AGENT_CHOICE" in *3*) SELECTED_AGENTS="${SELECTED_AGENTS}codex,";; esac
    case "$AGENT_CHOICE" in *4*) SELECTED_AGENTS="${SELECTED_AGENTS}opencode,";; esac
    SELECTED_AGENTS="${SELECTED_AGENTS%,}"
  fi

  if [ -z "$SELECTED_AGENTS" ]; then
    echo "  No agents selected — skipping hook patching."
    echo "  You can re-run setup.sh later to add hooks."
  else
    echo "  Selected: $SELECTED_AGENTS"
  fi
  echo ""
  echo "  Patching agent settings..."
fi

INTERCEPTOR_PATH="$INSTALL_DIR/interceptor.js"
INTERCEPTOR_POST_PATH="$INSTALL_DIR/interceptor-post.js"
STOP_PATH="$INSTALL_DIR/stop-extractor.js"

# Convert to forward slashes for Node.js on Windows
INTERCEPTOR_FWD=$(echo "$INTERCEPTOR_PATH" | sed 's|\\|/|g' | sed 's|^/\([a-zA-Z]\)/|\1:/|')
INTERCEPTOR_POST_FWD=$(echo "$INTERCEPTOR_POST_PATH" | sed 's|\\|/|g' | sed 's|^/\([a-zA-Z]\)/|\1:/|')
STOP_FWD=$(echo "$STOP_PATH" | sed 's|\\|/|g' | sed 's|^/\([a-zA-Z]\)/|\1:/|')

EXP_SELECTED_AGENTS="$SELECTED_AGENTS" EXP_INTERCEPTOR="$INTERCEPTOR_FWD" EXP_INTERCEPTOR_POST="$INTERCEPTOR_POST_FWD" EXP_STOP="$STOP_FWD" node << 'JSEOF'
const fs = require('fs'), path = require('path'), os = require('os');
const home = os.homedir();
const interceptor = process.env.EXP_INTERCEPTOR;
const interceptorPost = process.env.EXP_INTERCEPTOR_POST;
const stop = process.env.EXP_STOP;
const selected = (process.env.EXP_SELECTED_AGENTS || '').split(',').map(s => s.trim().toLowerCase());

const AGENTS = [
  {
    key: 'claude',
    name: 'Claude Code',
    file: path.join(home, '.claude', 'settings.json'),
    patch(cfg) {
      if (!cfg.hooks) cfg.hooks = {};
      cfg.hooks.PreToolUse = cfg.hooks.PreToolUse || [];
      if (!cfg.hooks.PreToolUse.some(h => (h.hooks||[]).some(e => e.command?.includes('interceptor')))) {
        cfg.hooks.PreToolUse.unshift({ matcher: 'Edit|Write|Bash', hooks: [{ type:'command', command:`node "${interceptor}"`, timeout:5 }] });
      }
      cfg.hooks.PostToolUse = cfg.hooks.PostToolUse || [];
      if (!cfg.hooks.PostToolUse.some(h => (h.hooks||[]).some(e => e.command?.includes('interceptor-post')))) {
        cfg.hooks.PostToolUse.push({ matcher: 'Edit|Write|Bash', hooks: [{ type:'command', command:`node "${interceptorPost}"`, timeout:5 }] });
      }
      cfg.hooks.Stop = cfg.hooks.Stop || [];
      if (!cfg.hooks.Stop.some(h => (h.hooks||[]).some(e => e.command?.includes('stop-extractor')))) {
        cfg.hooks.Stop.push({ hooks: [{ type:'command', command:`node "${stop}"`, timeout:90 }] });
      }
    }
  },
  {
    key: 'gemini',
    name: 'Gemini CLI',
    file: path.join(home, '.gemini', 'settings.json'),
    patch(cfg) {
      if (!cfg.hooks) cfg.hooks = {};
      cfg.hooks.BeforeTool = cfg.hooks.BeforeTool || [];
      if (!cfg.hooks.BeforeTool.some(h => (h.hooks||[]).some(e => e.command?.includes('interceptor')))) {
        cfg.hooks.BeforeTool.unshift({ matcher:'write_file|replace|replace_in_file|shell|execute_command', hooks:[{ name:'experience', type:'command', command:`node "${interceptor}"`, timeout:5000 }] });
      }
      cfg.hooks.AfterResponse = cfg.hooks.AfterResponse || [];
      if (!cfg.hooks.AfterResponse.some(h => (h.hooks||[]).some(e => e.command?.includes('stop-extractor')))) {
        cfg.hooks.AfterResponse.push({ hooks:[{ name:'experience-extractor', type:'command', command:`node "${stop}"`, timeout:90000 }] });
      }
    }
  },
  {
    key: 'codex',
    name: 'Codex CLI',
    file: path.join(home, '.codex', 'hooks.json'),
    patch(cfg) {
      // Codex CLI uses hooks.json (not config.json) + config.toml to enable hooks
      // Spec: PreToolUse/PostToolUse only support Bash tool
      // Ref: https://developers.openai.com/codex/hooks
      if (!cfg.hooks) cfg.hooks = {};
      cfg.hooks.PreToolUse = cfg.hooks.PreToolUse || [];
      if (!cfg.hooks.PreToolUse.some(h => (h.hooks||[]).some(e => e.command?.includes('interceptor')))) {
        cfg.hooks.PreToolUse.push({ matcher:'Bash', hooks:[{ type:'command', command:`node "${interceptor}"`, timeout:5 }] });
      }
      // Fix: update legacy matcher '.*' → 'Bash' (only tool Codex supports)
      for (const entry of cfg.hooks.PreToolUse) {
        if (entry.matcher === '.*' && (entry.hooks||[]).some(e => e.command?.includes('interceptor'))) {
          entry.matcher = 'Bash';
        }
      }
      cfg.hooks.PostToolUse = cfg.hooks.PostToolUse || [];
      if (!cfg.hooks.PostToolUse.some(h => (h.hooks||[]).some(e => e.command?.includes('interceptor-post')))) {
        cfg.hooks.PostToolUse.push({ matcher:'Bash', hooks:[{ type:'command', command:`node "${interceptorPost}"`, timeout:5 }] });
      }
      cfg.hooks.Stop = cfg.hooks.Stop || [];
      if (!cfg.hooks.Stop.some(h => (h.hooks||[]).some(e => e.command?.includes('stop-extractor')))) {
        cfg.hooks.Stop.push({ hooks:[{ type:'command', command:`node "${stop}"`, timeout:90 }] });
      }
      // Enable hooks feature in config.toml
      const tomlPath = path.join(home, '.codex', 'config.toml');
      try {
        let toml = '';
        try { toml = fs.readFileSync(tomlPath, 'utf8'); } catch {}
        if (!toml.includes('codex_hooks')) {
          toml += (toml && !toml.endsWith('\n') ? '\n' : '') + '[features]\ncodex_hooks = true\n';
          fs.writeFileSync(tomlPath, toml);
        }
      } catch {}
      // Platform warning: hooks disabled on native Windows
      const isWindows = process.platform === 'win32';
      const isWSL = fs.existsSync('/proc/version') && (fs.readFileSync('/proc/version','utf8').toLowerCase().includes('microsoft'));
      if (isWindows) {
        console.log('    ⚠ Codex hooks are disabled on native Windows.');
        console.log('    → Run Codex from WSL instead: wsl -d Ubuntu');
        console.log('    → Re-run setup.sh inside WSL to wire hooks.');
      } else if (isWSL) {
        console.log('    ✓ WSL detected — hooks will work from WSL Codex');
      }
    }
  },
  {
    key: 'opencode',
    name: 'OpenCode',
    file: path.join(home, '.config', 'opencode', 'config.json'),
    patch(cfg) {
      if (!cfg.hooks) cfg.hooks = {};
      cfg.hooks.before_tool = cfg.hooks.before_tool || [];
      if (!cfg.hooks.before_tool.some(h => h.command?.includes('interceptor'))) {
        cfg.hooks.before_tool.push({ command:`node "${interceptor}"`, timeout:5 });
      }
      cfg.hooks.after_response = cfg.hooks.after_response || [];
      if (!cfg.hooks.after_response.some(h => h.command?.includes('stop-extractor'))) {
        cfg.hooks.after_response.push({ command:`node "${stop}"`, timeout:90 });
      }
    }
  }
];

for (const agent of AGENTS) {
  if (selected.length > 0 && selected[0] !== '' && !selected.includes(agent.key)) {
    continue;
  }
  try {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(agent.file, 'utf8')); } catch {}
    agent.patch(cfg);
    fs.mkdirSync(path.dirname(agent.file), { recursive: true });
    fs.writeFileSync(agent.file, JSON.stringify(cfg, null, 2));
    console.log('  ' + agent.name);
  } catch(e) {
    console.log('  ' + agent.name + ': ' + e.message);
  }
}
JSEOF

# ── Auto-inject Experience Engine instruction block into agent MD files ──
echo ""
echo "  Injecting Experience Engine instructions into agent config files..."

EXP_INSTRUCTION_BLOCK='<!-- experience-engine:start -->
## Experience Engine Hooks

PreToolUse hooks inject experience-based warnings (`⚠️ [Experience]` / `💡 [Suggestion]`) before Edit/Write/Bash calls. Each warning includes a `Why:` line and ends with `[id:xxxx col:name]`.

- **Follow** high-confidence warnings — they reflect confirmed patterns.
- **If a warning is wrong or noisy** — tell the user immediately. Noise degrades ALL agents.
- **When you IGNORE a hint**, report it: `curl -s -X POST http://localhost:8082/api/feedback -H "Content-Type: application/json" -d '\''{"pointId":"xxxx","collection":"col-name","followed":false}'\''` (use the short ID from `[id:xxxx]`).
- Do NOT silently ignore repeated bad suggestions — feedback is critical for the engine to learn.
<!-- experience-engine:end -->'

# Inject into each MD file if the block doesn't already exist
for MD_FILE in \
  "$HOME/.claude/CLAUDE.md" \
  "$HOME/.gemini/GEMINI.md" \
  "$HOME/.codex/AGENTS.md" \
  "$HOME/.config/opencode/AGENTS.md"; do

  # Only inject if the parent directory exists (agent is installed)
  MD_DIR=$(dirname "$MD_FILE")
  if [ ! -d "$MD_DIR" ]; then
    continue
  fi

  # Create file if it doesn't exist
  if [ ! -f "$MD_FILE" ]; then
    echo "$EXP_INSTRUCTION_BLOCK" > "$MD_FILE"
    echo "  Created: $MD_FILE"
    continue
  fi

  # Skip if already injected
  if grep -q 'experience-engine:start' "$MD_FILE" 2>/dev/null; then
    # Replace existing block with updated version
    TMPFILE=$(mktemp)
    awk '/<!-- experience-engine:start -->/{skip=1} /<!-- experience-engine:end -->/{skip=0; next} !skip' "$MD_FILE" > "$TMPFILE"
    echo "$EXP_INSTRUCTION_BLOCK" >> "$TMPFILE"
    mv "$TMPFILE" "$MD_FILE"
    echo "  Updated: $MD_FILE"
    continue
  fi

  # Append to existing file
  echo "" >> "$MD_FILE"
  echo "$EXP_INSTRUCTION_BLOCK" >> "$MD_FILE"
  echo "  Injected: $MD_FILE"
done

# ── GSD Integration: patch Model Router into GSD framework ───────────────
GSD_DIR="$HOME/.claude/get-shit-done"
GSD_CORE="$GSD_DIR/bin/lib/core.cjs"
GSD_CONFIG="$GSD_DIR/bin/lib/config.cjs"
GSD_TOOLS="$GSD_DIR/bin/gsd-tools.cjs"

# Convert MSYS paths to Windows mixed paths for node.exe
# Use -m (forward slash) not -w (backslash) — backslashes get mangled
# in JS strings (\b=backspace, \n=newline, etc.)
if command -v cygpath &>/dev/null; then
  _GSD_CORE_WIN=$(cygpath -m "$GSD_CORE")
  _GSD_TOOLS_WIN=$(cygpath -m "$GSD_TOOLS")
else
  _GSD_CORE_WIN="$GSD_CORE"
  _GSD_TOOLS_WIN="$GSD_TOOLS"
fi

if [ -d "$GSD_DIR" ] && [ -f "$GSD_CORE" ]; then
  echo ""
  echo "◆ [5.5/6] GSD framework detected — patching Model Router integration..."

  # Patch 1: Add resolveModelWithRouter to core.cjs (if not already patched)
  if ! grep -q 'resolveModelWithRouter' "$GSD_CORE" 2>/dev/null; then
    EXP_PORT=8082
    node -e "
const fs = require('fs');
const corePath = '$_GSD_CORE_WIN';
let core = fs.readFileSync(corePath, 'utf8');

// Add resolveModelWithRouter after resolveModelInternal
const marker = 'return alias;\\n}';
const lastIdx = core.lastIndexOf('return alias;\\n}');
// Find the closing brace of resolveModelInternal
const funcEnd = core.indexOf('\\n}', core.indexOf('function resolveModelInternal'));
if (funcEnd < 0) { console.log('  Skip: cannot find resolveModelInternal end'); process.exit(0); }

const insertPos = funcEnd + 2;
const routerFn = \`

/**
 * Async model resolution via Experience Engine Model Router.
 * Falls back to resolveModelInternal() when router is unavailable.
 */
async function resolveModelWithRouter(cwd, agentType, taskDescription, runtime) {
  runtime = runtime || 'claude';
  const config = loadConfig(cwd);
  const override = config.model_overrides?.[agentType];
  if (override) return { model: override, tier: null, source: 'override' };
  const routerEnabled = config.workflow?.model_router !== false;
  const profile = String(config.model_profile || 'balanced').toLowerCase();
  if (!routerEnabled || !['balanced','adaptive','inherit'].includes(profile) || !taskDescription) {
    return { model: resolveModelInternal(cwd, agentType), tier: null, source: 'profile' };
  }
  try {
    const res = await fetch('http://localhost:${EXP_PORT}/api/route-model', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: taskDescription, runtime, context: { agent: agentType } }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      const model = data.model || resolveModelInternal(cwd, agentType);
      const resolved = config.resolve_model_ids ? (MODEL_ALIAS_MAP[model] || model) : model;
      return { model: resolved, tier: data.tier, source: data.source || 'router' };
    }
  } catch {}
  return { model: resolveModelInternal(cwd, agentType), tier: null, source: 'profile-fallback' };
}\`;

core = core.slice(0, insertPos) + routerFn + core.slice(insertPos);

// Add to exports
core = core.replace('resolveModelInternal,', 'resolveModelInternal,\\n  resolveModelWithRouter,');

fs.writeFileSync(corePath, core);
console.log('  Patched: core.cjs (resolveModelWithRouter)');
"
  else
    echo "  core.cjs: already patched"
  fi

  # Patch 2: Add workflow.model_router default to config.cjs
  if ! grep -q 'model_router' "$GSD_CONFIG" 2>/dev/null; then
    sed -i "s/code_review_depth: 'standard',/code_review_depth: 'standard',\n      model_router: true,/" "$GSD_CONFIG"
    echo "  Patched: config.cjs (model_router default)"
  else
    echo "  config.cjs: already patched"
  fi

  # Patch 3: Add route-model command to gsd-tools.cjs
  if ! grep -q 'route-model' "$GSD_TOOLS" 2>/dev/null; then
    node -e "
const fs = require('fs');
const toolsPath = '$_GSD_TOOLS_WIN';
let tools = fs.readFileSync(toolsPath, 'utf8');

const insertAfter = \"case 'resolve-model': {\\n      commands.cmdResolveModel(cwd, args[1], raw);\\n      break;\\n    }\";
const routeCmd = \`

    case 'route-model': {
      const agentType = args[1];
      const taskDesc = args.slice(2).filter(a => !a.startsWith('--')).join(' ');
      const runtimeIdx = args.indexOf('--runtime');
      const runtime = runtimeIdx >= 0 ? args[runtimeIdx + 1] : 'claude';
      if (!agentType) { core.output({ error: 'agent-type required' }, raw); break; }
      core.resolveModelWithRouter(cwd, agentType, taskDesc || '', runtime)
        .then(result => core.output(result, raw, result.model))
        .catch(e => core.output({ model: 'sonnet', tier: null, source: 'error', error: e.message }, raw, 'sonnet'));
      break;
    }\`;

tools = tools.replace(insertAfter, insertAfter + routeCmd);
fs.writeFileSync(toolsPath, tools);
console.log('  Patched: gsd-tools.cjs (route-model command)');
"
  else
    echo "  gsd-tools.cjs: already patched"
  fi

  echo "  GSD integration complete — run: gsd-tools route-model gsd-executor \"your task\""
else
  echo ""
  echo "  GSD framework not found at $GSD_DIR — skipping Model Router integration"
  echo "  Install GSD first, then re-run setup.sh to patch"
fi

# ── Step C execution: optional seed ───────────────────────────────────────
if [ "$DO_SEED" = "true" ] && [ -n "$SEED_DIR" ]; then
  echo ""
  echo "◆ Seeding brain from $SEED_DIR..."
  BULK_SEED="$SRC_DIR/../tools/experience-bulk-seed.js"
  if [ -f "$BULK_SEED" ]; then
    if ! node "$INSTALL_DIR/../tools/experience-bulk-seed.js" --memory-dir "$SEED_DIR" 2>/tmp/exp-seed-err; then
      echo "  Warning: seed step had errors: $(tail -3 /tmp/exp-seed-err)"
      echo "  You can retry: node ~/.experience/../tools/experience-bulk-seed.js --memory-dir $SEED_DIR"
    else
      echo "  Brain seeded from $SEED_DIR"
    fi
  else
    echo "  Warning: bulk-seed tool not found at $BULK_SEED — skipping seed"
  fi
fi

# ── Health Check ──────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Health Check"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

HEALTH_PASS=0
HEALTH_FAIL=0

# Load config for health check (handles both keep and new paths)
_node_run -e "
try {
  const c=JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.experience/config.json','utf8'));
  const fields=[
    'HC_qdrantUrl='+    (c.qdrantUrl||''),
    'HC_qdrantKey='+    (c.qdrantKey||''),
    'HC_embedProvider='+(c.embedProvider||''),
    'HC_brainProvider='+(c.brainProvider||''),
    'HC_embedDim='+     (c.embedDim||768),
    'HC_tunnelSsh='+    (c.tunnelSsh||''),
  ];
  process.stdout.write(fields.join('\n')+'\n');
} catch(e) {
  process.stderr.write('Cannot read config for health check: '+e.message+'\n');
}
"
_HC_RAW="$_NR_OUT"
while IFS='=' read -r k v; do
  [ -n "$k" ] && export "$k"="$v"
done <<< "$_HC_RAW"

# 1. Embed API probe
printf "  Embed API (%s)... " "$HC_embedProvider"
_NR_ERR=/dev/stdout _node_run -e "
(async () => {
  try {
    const core = require(require('path').join(require('os').homedir(),'.experience','experience-core.js'));
    const vec = await core.getEmbeddingRaw('health check probe');
    if(vec && vec.length > 0) { console.log('OK dim=' + vec.length); process.exit(0); }
    console.log('FAIL: empty response'); process.exit(1);
  } catch(e) { console.log('FAIL: ' + e.message); process.exit(1); }
})();
"
EMBED_RESULT="$_NR_OUT"
if [ $_NR_RC -eq 0 ]; then
  HEALTH_PASS=$((HEALTH_PASS+1))
  echo "$EMBED_RESULT"
else
  HEALTH_FAIL=$((HEALTH_FAIL+1))
  echo "$EMBED_RESULT"
  echo "    Fix: Check embed provider config and API key, then re-run setup.sh"
fi

# 2. Qdrant connectivity probe
printf "  Qdrant... "
_QU="${HC_qdrantUrl:-http://localhost:6333}"
_QK="${HC_qdrantKey:-}"
if [ -n "$_QK" ]; then
  QDRANT_CHECK=$(curl -s -o /dev/null -w "%{http_code}" "${_QU}/collections" \
    -H "api-key: $_QK" --connect-timeout 5 2>/dev/null)
else
  QDRANT_CHECK=$(curl -s -o /dev/null -w "%{http_code}" "${_QU}/collections" \
    --connect-timeout 5 2>/dev/null)
fi
if [ "$QDRANT_CHECK" = "200" ]; then
  echo "OK"
  HEALTH_PASS=$((HEALTH_PASS+1))
else
  echo "FAIL (HTTP $QDRANT_CHECK)"
  if [ -n "$HC_tunnelSsh" ]; then
    echo "    Tunnel configured: $HC_tunnelSsh"
    echo "    Fix: Start the SSH tunnel first, then re-run setup.sh"
    echo "         $HC_tunnelSsh"
  elif [[ "$_QU" == *localhost* ]] || [[ "$_QU" == *127.0.0.1* ]]; then
    echo "    Fix: Qdrant not reachable at ${_QU}"
    echo "         If Qdrant is on a remote VPS, you may need an SSH tunnel:"
    echo "         ssh -i ~/.ssh/KEY -f -N -L 6333:localhost:6333 user@vps-host"
    echo "         Or re-run setup.sh and choose option [3] VPS via SSH"
  else
    echo "    Fix: Check Qdrant is running at ${_QU}"
  fi
  HEALTH_FAIL=$((HEALTH_FAIL+1))
fi

# 3. Qdrant collections dimension check
printf "  Collections... "
_COLL_PROBE=$(mktemp /tmp/exp-coll-probe.XXXXXX.js)
cat > "$_COLL_PROBE" <<'JSEOF'
(async () => {
  try {
    const cfg = JSON.parse(require('fs').readFileSync(require('path').join(require('os').homedir(),'.experience','config.json'),'utf8'));
    const base = cfg.qdrantUrl || 'http://localhost:6333';
    const headers = cfg.qdrantKey ? {'api-key': cfg.qdrantKey} : {};
    const colls = ['experience-principles','experience-behavioral','experience-selfqa'];
    let ok = 0;
    for (const c of colls) {
      const r = await fetch(base+'/collections/'+c, {headers, signal: AbortSignal.timeout(3000)});
      if (!r.ok) { console.log('FAIL: ' + c + ' not found'); process.exit(1); }
      const d = await r.json();
      const dim = d.result?.config?.params?.vectors?.size;
      if (dim !== cfg.embedDim) { console.log('FAIL: ' + c + ' dim=' + dim + ' expected=' + cfg.embedDim); process.exit(1); }
      ok++;
    }
    console.log('OK (' + ok + '/3 collections, dim=' + cfg.embedDim + ')');
  } catch(e) { console.log('FAIL: ' + e.message); process.exit(1); }
})();
JSEOF
_NR_ERR=/dev/stdout _node_run "$_COLL_PROBE"
rm -f "$_COLL_PROBE"
COLL_RESULT="$_NR_OUT"
if [ $_NR_RC -eq 0 ]; then
  HEALTH_PASS=$((HEALTH_PASS+1))
  echo "$COLL_RESULT"
else
  HEALTH_FAIL=$((HEALTH_FAIL+1))
  echo "$COLL_RESULT"
  echo "    Fix: Re-run setup.sh to recreate collections with correct dimensions"
fi

echo ""
if [ "$HEALTH_FAIL" -eq 0 ]; then
  echo "  All checks passed ($HEALTH_PASS/$HEALTH_PASS)"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " Experience Engine v3.2 — INSTALLED"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo " Brain installed at: $INSTALL_DIR/"
  echo " Config at:          $INSTALL_DIR/config.json"
  echo ""
  echo " Works in ANY project — no per-project setup needed."
  echo " Reconfigure: run setup.sh again and choose [2] Reconfigure."
  echo ""
  echo " ── Experience Hook Awareness ──"
  echo ""
  echo " Agent instruction blocks auto-injected into:"
  echo "   CLAUDE.md, GEMINI.md, AGENTS.md (where present)"
  echo ""
  echo " Hooks installed: PreToolUse (intercept) + PostToolUse (feedback) + Stop (extract)"
  echo ""
else
  echo "  $HEALTH_FAIL check(s) failed. Fix the issues above, then re-run setup.sh."
fi

# ── Remote deploy (--remote flag) ───────────────────────────────────────────
if [ -n "$REMOTE_HOST" ]; then
  echo ""
  echo "── Remote Deploy ──────────────────────────────────────────────"
  SSH_OPTS="-o StrictHostKeyChecking=no -o BatchMode=yes"
  [ -n "$REMOTE_KEY" ] && SSH_OPTS="$SSH_OPTS -i \"$REMOTE_KEY\""

  echo "  Target: $REMOTE_HOST:~/.experience/"

  # Check if remote config already exists — warn before overwriting
  REMOTE_HAS_CONFIG=$(ssh $SSH_OPTS "$REMOTE_HOST" "test -f ~/.experience/config.json && echo yes || echo no" 2>/dev/null)
  SKIP_REMOTE_CONFIG=""
  if [ "$REMOTE_HAS_CONFIG" = "yes" ]; then
    echo "  Warning: remote ~/.experience/config.json already exists."
    read -r -p "  Overwrite remote config? [y/N]: " OVERWRITE_CONF
    if [ "$OVERWRITE_CONF" != "y" ] && [ "$OVERWRITE_CONF" != "Y" ]; then
      echo "  Skipping config overwrite — copying JS files only."
      SKIP_REMOTE_CONFIG=1
    fi
  fi

  # Create remote directory
  ssh $SSH_OPTS "$REMOTE_HOST" "mkdir -p ~/.experience/tmp ~/.experience/store" 2>/dev/null

  # Copy 6 core files
  REMOTE_FILES=(
    "$INSTALL_DIR/experience-core.js"
    "$INSTALL_DIR/interceptor.js"
    "$INSTALL_DIR/interceptor-post.js"
    "$INSTALL_DIR/judge-worker.js"
    "$INSTALL_DIR/stop-extractor.js"
  )
  [ -z "$SKIP_REMOTE_CONFIG" ] && REMOTE_FILES+=("$INSTALL_DIR/config.json")

  SCP_CMD="scp $SSH_OPTS"
  for FILE in "${REMOTE_FILES[@]}"; do
    if [ -f "$FILE" ]; then
      $SCP_CMD "$FILE" "$REMOTE_HOST:~/.experience/" 2>/dev/null \
        && echo "  Copied: $(basename "$FILE")" \
        || echo "  [FAIL] $(basename "$FILE")"
    fi
  done

  # Verify remote health
  echo ""
  echo "  Verifying remote..."
  REMOTE_NODE=$(ssh $SSH_OPTS "$REMOTE_HOST" "node ~/.experience/experience-core.js --version 2>/dev/null || echo 'node-fail'" 2>/dev/null)
  REMOTE_QDRANT=$(ssh $SSH_OPTS "$REMOTE_HOST" \
    "QDRANT_URL=\$(node -e \"try{const c=JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.experience/config.json','utf8'));process.stdout.write(c.qdrantUrl||'http://localhost:6333')}catch{process.stdout.write('http://localhost:6333')}\"); curl -s -m 5 \"\$QDRANT_URL/health\" | grep -c ok" \
    2>/dev/null)

  [ "$REMOTE_NODE" != "node-fail" ] \
    && echo "  [OK] experience-core.js reachable on remote" \
    || echo "  [WARN] node check failed on remote — verify node is installed"
  [ "$REMOTE_QDRANT" = "1" ] \
    && echo "  [OK] Qdrant healthy on remote" \
    || echo "  [WARN] Qdrant health check failed on remote"

  echo ""
  echo "  Remote deploy complete: $REMOTE_HOST"
  echo "────────────────────────────────────────────────────────────────"
fi
