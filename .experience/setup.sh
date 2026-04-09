#!/bin/bash
# Experience Engine — Universal Setup
#
# Works from ANY project directory. Installs brain to ~/.experience/ (user-level).
# Global agent hooks point to ~/.experience/ — no project path hardcoded.
#
# Usage:
#   bash .experience/setup.sh                    # interactive config
#   bash .experience/setup.sh --local            # use local Qdrant + Ollama
#   bash .experience/setup.sh --vps              # use VPS (prompts for details)
#   EXP_QDRANT_URL=http://... bash setup.sh      # fully non-interactive via env
#
# Supported agents: Claude Code, Gemini CLI, Codex CLI, OpenCode
# Prerequisites: Node.js 20+

set -e

INSTALL_DIR="$HOME/.experience"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 🧠 Experience Engine — Universal Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Install dir: $INSTALL_DIR"
echo ""

# ── Step 1: Resolve config ─────────────────────────────────────────────────
echo "◆ [1/5] Resolving config..."

# Priority: env vars > existing config file > interactive prompts
CONFIG_FILE="$INSTALL_DIR/config.json"

if [ -f "$CONFIG_FILE" ] && [ -z "$EXP_RESET_CONFIG" ]; then
  echo "  ✓ Existing config found"
  echo ""
  echo "  [1] Keep existing config"
  echo "  [2] Reconfigure from scratch"
  printf "  Choice [1/2]: "; read -r REUSE_CHOICE
  if [ "$REUSE_CHOICE" = "2" ]; then
    echo "  → Starting fresh..."
    rm -f "$CONFIG_FILE"
    # Fall through to interactive prompts below
  fi
fi

if [ -f "$CONFIG_FILE" ] && [ -z "$EXP_RESET_CONFIG" ]; then
  # Load config fields via node writing to stdout, read with while+IFS
  while IFS='=' read -r key val; do
    [ -n "$key" ] && export "$key"="$val"
  done < <(node -e "
const fs=require('fs'),path=require('path'),os=require('os');
const f=path.join(os.homedir(),'.experience','config.json');
try{
  const c=JSON.parse(fs.readFileSync(f,'utf8'));
  const ep=c.embedProvider||(c.openaiKey?'openai':c.geminiKey?'gemini':'ollama');
  const bp=c.brainProvider||(c.openaiKey?'openai':c.geminiKey?'gemini':c.anthropicKey?'claude':c.deepseekKey?'deepseek':'ollama');
  process.stdout.write([
    'QDRANT_URL='+  (c.qdrantUrl||''),
    'QDRANT_KEY='+  (c.qdrantKey||''),
    'OLLAMA_URL='+  (c.ollamaUrl||''),
    'TUNNEL_SSH='+  (c.tunnelSsh||''),
    'EMBED_PROVIDER='+ ep,
    'BRAIN_PROVIDER='+ bp,
    'EXP_BRAIN_MODEL='+(c.brainModel||''),
    'EXP_BRAIN_ENDPOINT='+(c.brainEndpoint||''),
    'EXP_BRAIN_KEY='+(c.brainKey||''),
    'OPENAI_KEY='+  (c.openaiKey||''),
    'GEMINI_KEY='+  (c.geminiKey||''),
    'ANTHROPIC_KEY='+(c.anthropicKey||''),
    'DEEPSEEK_KEY='+ (c.deepseekKey||''),
  ].join('\n')+'\n');
}catch{}
" 2>/dev/null)

  # Validate: cloud providers MUST have API keys — if missing, force reconfigure
  CONFIG_VALID=true
  if [ "$EMBED_PROVIDER" = "openai" ] && [ -z "$OPENAI_KEY" ] && [ -z "$EXP_BRAIN_KEY" ]; then
    echo "  ⚠ OpenAI selected but no API key found"
    CONFIG_VALID=false
  elif [ "$EMBED_PROVIDER" = "gemini" ] && [ -z "$GEMINI_KEY" ]; then
    echo "  ⚠ Gemini selected but no API key found"
    CONFIG_VALID=false
  fi
  if [ "$BRAIN_PROVIDER" = "claude" ] && [ -z "$ANTHROPIC_KEY" ]; then
    echo "  ⚠ Claude brain selected but no API key found"
    CONFIG_VALID=false
  elif [ "$BRAIN_PROVIDER" = "deepseek" ] && [ -z "$DEEPSEEK_KEY" ]; then
    echo "  ⚠ DeepSeek brain selected but no API key found"
    CONFIG_VALID=false
  fi
  if [ "$BRAIN_PROVIDER" = "ollama" ] || [ "$EMBED_PROVIDER" = "ollama" ]; then
    if [ -n "$OLLAMA_URL" ]; then
      if ! curl -s -m 3 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
        echo "  ⚠ Ollama selected but not reachable at $OLLAMA_URL"
        CONFIG_VALID=false
      fi
    fi
  fi

  if [ "$CONFIG_VALID" = false ]; then
    echo ""
    echo "  Config has issues. What do you want to do?"
    echo "  [1] Reconfigure (pick new provider)"
    echo "  [2] Keep and continue anyway"
    printf "  Choice [1/2]: "; read -r FIX_CHOICE
    if [ "$FIX_CHOICE" = "1" ]; then
      # Clear provider vars to trigger interactive prompts
      unset EMBED_PROVIDER BRAIN_PROVIDER QDRANT_URL
      echo "  → Reconfiguring..."
    else
      echo "  → Keeping existing config"
    fi
  else
    echo "  ✓ Config valid — reusing"
  fi
fi

# Env var overrides
[ -n "$EXP_QDRANT_URL" ]      && QDRANT_URL="$EXP_QDRANT_URL"
[ -n "$EXP_QDRANT_KEY" ]      && QDRANT_KEY="$EXP_QDRANT_KEY"
[ -n "$EXP_OLLAMA_URL" ]      && OLLAMA_URL="$EXP_OLLAMA_URL"
[ -n "$EXP_TUNNEL_SSH" ]      && TUNNEL_SSH="$EXP_TUNNEL_SSH"
[ -n "$EXP_EMBED_PROVIDER" ]  && EMBED_PROVIDER="$EXP_EMBED_PROVIDER"
[ -n "$EXP_BRAIN_PROVIDER" ]  && BRAIN_PROVIDER="$EXP_BRAIN_PROVIDER"

# Auto-detect provider from env vars if not explicitly set
# Embed: prefer Ollama if URL set (free), then cloud APIs
if [ -z "$EMBED_PROVIDER" ]; then
  if [ -n "$EXP_OLLAMA_URL" ]; then EMBED_PROVIDER="ollama"
  elif [ -n "$OPENAI_API_KEY" ]; then EMBED_PROVIDER="openai"
  elif [ -n "$GEMINI_API_KEY" ]; then EMBED_PROVIDER="gemini"
  fi
fi
if [ -z "$BRAIN_PROVIDER" ]; then
  if [ -n "$EXP_BRAIN_KEY" ] || [ -n "$EXP_BRAIN_ENDPOINT" ]; then BRAIN_PROVIDER="openai"
  elif [ -n "$OPENAI_API_KEY" ]; then BRAIN_PROVIDER="openai"
  elif [ -n "$GEMINI_API_KEY" ]; then BRAIN_PROVIDER="gemini"
  elif [ -n "$ANTHROPIC_API_KEY" ]; then BRAIN_PROVIDER="claude"
  elif [ -n "$DEEPSEEK_API_KEY" ]; then BRAIN_PROVIDER="deepseek"
  elif [ -n "$EXP_OLLAMA_URL" ]; then BRAIN_PROVIDER="ollama"
  fi
fi

# Interactive prompts if still missing
if [ -z "$QDRANT_URL" ]; then
  echo "  ┌─────────────────────────────────────────────────────┐"
  echo "  │  Step A — Vector store:                              │"
  echo "  │  [1] Qdrant Cloud  (free tier — cloud.qdrant.io)    │"
  echo "  │  [2] Local Docker  (docker run qdrant/qdrant)       │"
  echo "  │  [3] VPS tunnel    (SSH -L to your server)          │"
  echo "  └─────────────────────────────────────────────────────┘"
  printf "  Choice [1/2/3]: "; read -r STORE_CHOICE

  case "$STORE_CHOICE" in
    1)
      echo "    → cloud.qdrant.io → New Cluster → copy URL + API key"
      printf "  Qdrant URL: "; read -r QDRANT_URL
      printf "  Qdrant API key: "; read -r QDRANT_KEY ;;
    2)
      if ! docker ps >/dev/null 2>&1; then echo "  ✗ Docker not running."; exit 1; fi
      docker ps | grep -q qdrant || { docker run -d --name qdrant -p 6333:6333 qdrant/qdrant >/dev/null 2>&1; sleep 2; }
      QDRANT_URL="http://localhost:6333"; QDRANT_KEY=""
      echo "  ✓ Qdrant running on localhost:6333" ;;
    3)
      printf "  VPS user@host: "; read -r VPS_HOST
      printf "  SSH key [~/.ssh/id_rsa]: "; read -r VPS_KEY; VPS_KEY="${VPS_KEY:-$HOME/.ssh/id_rsa}"
      QDRANT_URL="http://localhost:16333"
      TUNNEL_SSH="ssh -i $VPS_KEY -f -N -o ServerAliveInterval=60 -L 16333:localhost:6333 $VPS_HOST"
      printf "  Qdrant API key on VPS: "; read -r QDRANT_KEY ;;
  esac
fi

if [ -z "$EMBED_PROVIDER" ]; then
  echo ""
  echo "  ┌──────────────────────────────────────────────────────┐"
  echo "  │  Step B — AI provider (embedding + extraction):      │"
  echo "  │  [1] OpenAI       sk-...   embed + brain in one key  │"
  echo "  │  [2] Gemini       AIza...  free tier available        │"
  echo "  │  [3] Claude       sk-ant-  haiku brain, need embed   │"
  echo "  │  [4] DeepSeek     ...      cheapest direct API        │"
  echo "  │  [5] SiliconFlow  sk-...   cheapest OpenAI-compatible │"
  echo "  │  [6] Custom       any OpenAI-compatible endpoint      │"
  echo "  │  [7] Ollama       local    100%% free, no API key     │"
  echo "  └──────────────────────────────────────────────────────┘"
  printf "  Choice [1-7]: "; read -r AI_CHOICE

  case "$AI_CHOICE" in
    1)
      echo "    → platform.openai.com/api-keys"
      printf "  OpenAI API key (sk-...): "; read -r OPENAI_KEY
      EMBED_PROVIDER="openai"; BRAIN_PROVIDER="openai" ;;
    2)
      echo "    → aistudio.google.com/apikey"
      printf "  Gemini API key (AIza...): "; read -r GEMINI_KEY
      EMBED_PROVIDER="gemini"; BRAIN_PROVIDER="gemini" ;;
    3)
      echo "    → console.anthropic.com/settings/keys"
      echo "    Note: Claude has no embedding API — need Ollama or another embed provider"
      printf "  Anthropic API key (sk-ant-...): "; read -r ANTHROPIC_KEY
      printf "  Ollama URL for embedding [http://localhost:11434]: "; read -r OLLAMA_URL
      OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
      EMBED_PROVIDER="ollama"; BRAIN_PROVIDER="claude" ;;
    4)
      echo "    → platform.deepseek.com/api_keys"
      echo "    Note: DeepSeek has no embedding API — need Ollama for embed"
      printf "  DeepSeek API key: "; read -r DEEPSEEK_KEY
      printf "  Ollama URL for embedding [http://localhost:11434]: "; read -r OLLAMA_URL
      OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
      EMBED_PROVIDER="ollama"; BRAIN_PROVIDER="deepseek" ;;
    5)
      echo "    → docs.siliconflow.com → Get API key"
      echo "    SiliconFlow supports embed + brain — no Ollama needed!"
      printf "  SiliconFlow API key (sk-...): "; read -r SF_KEY
      printf "  Brain model [Qwen/Qwen2.5-7B-Instruct]: "; read -r SF_BRAIN
      SF_BRAIN="${SF_BRAIN:-Qwen/Qwen2.5-7B-Instruct}"
      printf "  Embed model [Qwen/Qwen3-Embedding-0.6B]: "; read -r SF_EMBED
      SF_EMBED="${SF_EMBED:-Qwen/Qwen3-Embedding-0.6B}"
      EMBED_PROVIDER="openai"; BRAIN_PROVIDER="openai"
      EXP_BRAIN_ENDPOINT="https://api.siliconflow.com/v1/chat/completions"
      EXP_BRAIN_KEY="$SF_KEY"
      EXP_BRAIN_MODEL="$SF_BRAIN"
      EXP_EMBED_ENDPOINT="https://api.siliconflow.com/v1/embeddings"
      EXP_EMBED_KEY="$SF_KEY"
      EXP_EMBED_MODEL="$SF_EMBED" ;;
    6)
      echo "    Any OpenAI-compatible API (Together, Groq, Fireworks, etc.)"
      printf "  Chat completions URL (e.g. https://api.xxx.com/v1/chat/completions): "; read -r EXP_BRAIN_ENDPOINT
      printf "  API key: "; read -r EXP_BRAIN_KEY
      printf "  Model name: "; read -r EXP_BRAIN_MODEL
      printf "  Ollama URL for embedding [http://localhost:11434]: "; read -r OLLAMA_URL
      OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
      EMBED_PROVIDER="ollama"; BRAIN_PROVIDER="openai" ;;
    7)
      if ! command -v ollama >/dev/null 2>&1; then echo "  ✗ Install Ollama from https://ollama.ai"; exit 1; fi
      echo "  ○ Pulling models (first time: a few minutes)..."
      ollama pull nomic-embed-text >/dev/null 2>&1 & ollama pull qwen2.5:3b >/dev/null 2>&1 & wait
      OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
      EMBED_PROVIDER="ollama"; BRAIN_PROVIDER="ollama"
      echo "  ✓ Ollama ready" ;;
  esac
fi

echo "  ✓ Config resolved"

# ── Step 2: Install to ~/.experience/ ─────────────────────────────────────
echo "◆ [2/5] Installing to $INSTALL_DIR..."

mkdir -p "$INSTALL_DIR"

# Copy core files
cp "$SRC_DIR/experience-core.js" "$INSTALL_DIR/experience-core.js"

# Write wrapper hooks (self-contained, no relative paths)
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
  if (count > 0) process.stderr.write('🧠 Experience: +' + count + ' lessons\n');
  // Evolution trigger with 24h throttle (per D-08)
  try {
    const evolveMarker = home + '/.experience/.evolve-marker';
    let lastEvolve = 0;
    try { lastEvolve = JSON.parse(fs.readFileSync(evolveMarker, 'utf8')).ts || 0; } catch {}
    if (Date.now() - lastEvolve > 86400000) { // 24 hours
      const { evolve } = require(home + '/.experience/experience-core.js');
      const r = await evolve();
      fs.writeFileSync(evolveMarker, JSON.stringify({ ts: Date.now() }));
      const total = r.promoted + r.abstracted + r.demoted + r.archived;
      if (total > 0) process.stderr.write('🧬 Evolution: +' + r.promoted + ' promoted, ' + r.abstracted + ' abstracted, ' + r.demoted + ' demoted, ' + r.archived + ' archived\n');
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

chmod +x "$INSTALL_DIR/interceptor.js" "$INSTALL_DIR/stop-extractor.js"

# Write config.json — use env vars inside Node to avoid path mangling
EXP_Q_URL="$QDRANT_URL"     EXP_Q_KEY="$QDRANT_KEY" \
EXP_OLLAMA="$OLLAMA_URL"    EXP_TUNNEL="$TUNNEL_SSH" \
EXP_OPENAI="$OPENAI_KEY"    EXP_GEMINI="$GEMINI_KEY" \
EXP_ANTHROPIC="$ANTHROPIC_KEY" EXP_DEEPSEEK="$DEEPSEEK_KEY" \
EXP_EMBED_P="$EMBED_PROVIDER"  EXP_BRAIN_P="$BRAIN_PROVIDER" \
node << 'JSEOF'
const fs = require('fs'), path = require('path'), os = require('os');
const e = process.env;
const embedP = e.EXP_EMBED_P || (e.EXP_OPENAI ? 'openai' : e.EXP_GEMINI ? 'gemini' : 'ollama');
const brainP = e.EXP_BRAIN_P || (e.EXP_OPENAI ? 'openai' : e.EXP_GEMINI ? 'gemini' : e.EXP_ANTHROPIC ? 'claude' : e.EXP_DEEPSEEK ? 'deepseek' : 'ollama');
const embedDims = { openai:1536, gemini:768, voyageai:1024, ollama:768 };
const embedModels = { openai:'text-embedding-3-small', gemini:'text-embedding-004', voyageai:'voyage-code-3', ollama:'nomic-embed-text' };
const brainModels = { openai:'gpt-4o-mini', gemini:'gemini-2.0-flash', claude:'claude-haiku-4-5-20251001', deepseek:'deepseek-chat', ollama:'qwen2.5:3b' };

const cfg = {
  qdrantUrl:      e.EXP_Q_URL    || 'http://localhost:6333',
  qdrantKey:      e.EXP_Q_KEY    || '',
  ollamaUrl:      e.EXP_OLLAMA   || '',
  tunnelSsh:      e.EXP_TUNNEL   || '',
  openaiKey:      e.EXP_OPENAI   || '',
  geminiKey:      e.EXP_GEMINI   || '',
  anthropicKey:   e.EXP_ANTHROPIC|| '',
  deepseekKey:    e.EXP_DEEPSEEK || '',
  embedProvider:  embedP,
  brainProvider:  brainP,
  embedModel:     e.EXP_EMBED_MODEL  || embedModels[embedP] || 'nomic-embed-text',
  brainModel:     e.EXP_BRAIN_MODEL  || brainModels[brainP] || 'qwen2.5:3b',
  brainEndpoint:  e.EXP_BRAIN_ENDPOINT || '',
  brainKey:       e.EXP_BRAIN_KEY      || '',
  embedEndpoint:  e.EXP_EMBED_ENDPOINT || '',
  embedKey:       e.EXP_EMBED_KEY      || '',
  embedDim:       embedDims[embedP]   || 768,
  installedAt: new Date().toISOString(),
  version: '3.0'
};
const file = path.join(os.homedir(), '.experience', 'config.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
console.log('  ✓ Config saved');
console.log('  ✓ Embed:  ' + embedP + ' (' + cfg.embedModel + ')');
console.log('  ✓ Brain:  ' + brainP + ' (' + cfg.brainModel + ')');
JSEOF

# Patch experience-core.js to read config from ~/.experience/config.json
node << 'JSEOF'
const fs = require('fs');
const home = require('os').homedir();
const coreFile = home + '/.experience/experience-core.js';
let core = fs.readFileSync(coreFile, 'utf8');
const configBlock = `
// --- Load config from ~/.experience/config.json (set by setup.sh) ---
(function() {
  try {
    const cfg = JSON.parse(require('fs').readFileSync(require('os').homedir() + '/.experience/config.json', 'utf8'));
    const set = (e, v) => { if (v && !process.env[e]) process.env[e] = v; };
    set('EXPERIENCE_QDRANT_URL',  cfg.qdrantUrl);
    set('EXPERIENCE_QDRANT_KEY',  cfg.qdrantKey);
    set('EXPERIENCE_OLLAMA_URL',  cfg.ollamaUrl);
    set('EXPERIENCE_EMBED_MODEL', cfg.embedModel);
    set('EXPERIENCE_BRAIN_MODEL', cfg.brainModel);
    set('EXPERIENCE_EMBED_PROVIDER',  cfg.embedProvider);
    set('EXPERIENCE_BRAIN_PROVIDER',  cfg.brainProvider);
    set('EXPERIENCE_BRAIN_ENDPOINT',  cfg.brainEndpoint);
    set('EXPERIENCE_BRAIN_KEY',       cfg.brainKey);
    set('EXPERIENCE_EMBED_ENDPOINT',  cfg.embedEndpoint);
    set('EXPERIENCE_EMBED_KEY',       cfg.embedKey);
    set('OPENAI_API_KEY',    cfg.openaiKey);
    set('GEMINI_API_KEY',    cfg.geminiKey);
    set('ANTHROPIC_API_KEY', cfg.anthropicKey);
    set('DEEPSEEK_API_KEY',  cfg.deepseekKey);
  } catch {}
})();
`;
if (!core.includes('Load config from ~/.experience')) {
  core = core.replace("'use strict';", "'use strict';\n" + configBlock);
  fs.writeFileSync(coreFile, core);
  console.log('  ✓ Config loader injected into experience-core.js');
}
JSEOF

echo "  ✓ Installed: $INSTALL_DIR/"

# ── Step 3: Start tunnel (if VPS mode) ────────────────────────────────────
if [ -n "$TUNNEL_SSH" ]; then
  echo "◆ [3/5] Starting SSH tunnel..."
  LOCAL_PORT=$(echo "$QDRANT_URL" | grep -o ':[0-9]*$' | tr -d ':')
  if curl -s -m 2 "$QDRANT_URL/collections" >/dev/null 2>&1; then
    echo "  ✓ Tunnel already active"
  else
    eval "$TUNNEL_SSH" 2>/dev/null && sleep 2
    if curl -s -m 3 "$QDRANT_URL/collections" >/dev/null 2>&1; then
      echo "  ✓ Tunnel started"
    else
      echo "  ✗ Tunnel failed — check SSH config"
    fi
  fi

  # Auto-start on boot
  OS=$(uname -s 2>/dev/null || echo "Windows")
  case "$OS" in
    MINGW*|MSYS*|CYGWIN*|Windows*)
      STARTUP="$APPDATA/Microsoft/Windows/Start Menu/Programs/Startup/experience-tunnel.vbs"
      echo "Set WshShell = CreateObject(\"WScript.Shell\")" > "$STARTUP"
      echo "WshShell.Run \"$TUNNEL_SSH\", 0, False" >> "$STARTUP"
      echo "  ✓ Auto-start: Windows startup script"
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
      echo "  ✓ Auto-start: macOS LaunchAgent"
      ;;
    Linux*)
      SERVICE="$HOME/.config/systemd/user/experience-engine-tunnel.service"
      mkdir -p "$(dirname "$SERVICE")"
      printf "[Unit]\nDescription=Experience Engine Tunnel\nAfter=network.target\n[Service]\nExecStart=%s\nRestart=always\n[Install]\nWantedBy=default.target\n" "$TUNNEL_SSH" > "$SERVICE"
      systemctl --user daemon-reload && systemctl --user enable --now experience-engine-tunnel.service 2>/dev/null
      echo "  ✓ Auto-start: systemd service"
      ;;
  esac
else
  echo "◆ [3/5] No tunnel needed (local or cloud Qdrant)"
fi

# ── Step 4: Ensure Qdrant collections exist ───────────────────────────────
echo "◆ [4/5] Verifying Qdrant collections..."
QDRANT_AUTH=""
[ -n "$QDRANT_KEY" ] && QDRANT_AUTH="-H \"api-key: $QDRANT_KEY\""

# Read embedDim from config.json (per D-01)
EMBED_DIM=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.experience/config.json','utf8')).embedDim||768)}catch{console.log(768)}")

for COLL in experience-principles experience-behavioral experience-selfqa; do
  COLL_INFO=$(eval "curl -s -m 5 $QDRANT_AUTH $QDRANT_URL/collections/$COLL" 2>/dev/null)
  STATUS=$(echo "$COLL_INFO" | grep -o '"status":"[^"]*"' | head -1)
  CURRENT_DIM=$(echo "$COLL_INFO" | grep -o '"size":[0-9]*' | head -1 | cut -d: -f2)

  if echo "$STATUS" | grep -q "green\|yellow"; then
    if [ -n "$CURRENT_DIM" ] && [ "$CURRENT_DIM" != "$EMBED_DIM" ]; then
      echo "  ⚠ $COLL dimension mismatch: have ${CURRENT_DIM}, need ${EMBED_DIM} — recreating..."
      eval "curl -s -m 5 -X DELETE $QDRANT_AUTH $QDRANT_URL/collections/$COLL" >/dev/null
      eval "curl -s -m 5 -X PUT $QDRANT_AUTH $QDRANT_URL/collections/$COLL \
        -H 'Content-Type: application/json' \
        -d '{\"vectors\":{\"size\":'$EMBED_DIM',\"distance\":\"Cosine\"}}'" >/dev/null
      echo "  ✓ $COLL recreated (dim=$EMBED_DIM)"
    else
      echo "  ✓ $COLL exists (dim=$CURRENT_DIM)"
    fi
  else
    eval "curl -s -m 5 -X PUT $QDRANT_AUTH $QDRANT_URL/collections/$COLL \
      -H 'Content-Type: application/json' \
      -d '{\"vectors\":{\"size\":'$EMBED_DIM',\"distance\":\"Cosine\"}}'" >/dev/null
    echo "  + $COLL created (dim=$EMBED_DIM)"
  fi
done

# ── Step 5: Patch global agent settings ───────────────────────────────────
echo "◆ [5/5] Patching global agent settings..."

INTERCEPTOR_PATH="$INSTALL_DIR/interceptor.js"
STOP_PATH="$INSTALL_DIR/stop-extractor.js"

# Convert to forward slashes for Node.js on Windows
INTERCEPTOR_FWD=$(echo "$INTERCEPTOR_PATH" | sed 's|\\|/|g' | sed 's|^/\([a-zA-Z]\)/|\1:/|')
STOP_FWD=$(echo "$STOP_PATH" | sed 's|\\|/|g' | sed 's|^/\([a-zA-Z]\)/|\1:/|')

EXP_INTERCEPTOR="$INTERCEPTOR_FWD" EXP_STOP="$STOP_FWD" node << 'JSEOF'
const fs = require('fs'), path = require('path'), os = require('os');
const home = os.homedir();
const interceptor = process.env.EXP_INTERCEPTOR;
const stop = process.env.EXP_STOP;

const AGENTS = [
  {
    name: 'Claude Code',
    file: path.join(home, '.claude', 'settings.json'),
    patch(cfg) {
      if (!cfg.hooks) cfg.hooks = {};
      cfg.hooks.PreToolUse = cfg.hooks.PreToolUse || [];
      if (!cfg.hooks.PreToolUse.some(h => (h.hooks||[]).some(e => e.command?.includes('interceptor')))) {
        cfg.hooks.PreToolUse.unshift({ matcher: 'Edit|Write|Bash', hooks: [{ type:'command', command:`node "${interceptor}"`, timeout:5 }] });
      }
      cfg.hooks.Stop = cfg.hooks.Stop || [];
      if (!cfg.hooks.Stop.some(h => (h.hooks||[]).some(e => e.command?.includes('stop-extractor')))) {
        cfg.hooks.Stop.push({ hooks: [{ type:'command', command:`node "${stop}"`, timeout:90 }] });
      }
    }
  },
  {
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
    name: 'Codex CLI',
    file: path.join(home, '.codex', 'config.json'),
    patch(cfg) {
      if (!cfg.hooks) cfg.hooks = {};
      cfg.hooks.PreToolUse = cfg.hooks.PreToolUse || [];
      if (!cfg.hooks.PreToolUse.some(h => (h.hooks||[]).some(e => e.command?.includes('interceptor')))) {
        cfg.hooks.PreToolUse.push({ matcher:'.*', hooks:[{ type:'command', command:`node "${interceptor}"`, timeout:5 }] });
      }
      cfg.hooks.Stop = cfg.hooks.Stop || [];
      if (!cfg.hooks.Stop.some(h => (h.hooks||[]).some(e => e.command?.includes('stop-extractor')))) {
        cfg.hooks.Stop.push({ hooks:[{ type:'command', command:`node "${stop}"`, timeout:90 }] });
      }
    }
  },
  {
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
  try {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(agent.file, 'utf8')); } catch {}
    agent.patch(cfg);
    fs.mkdirSync(path.dirname(agent.file), { recursive: true });
    fs.writeFileSync(agent.file, JSON.stringify(cfg, null, 2));
    console.log('  ✓ ' + agent.name);
  } catch(e) {
    console.log('  ○ ' + agent.name + ': ' + e.message);
  }
}
JSEOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 🧠 Experience Engine v3.0 — INSTALLED"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " Brain:   $INSTALL_DIR/"
echo " Qdrant:  $QDRANT_URL"
echo " Ollama:  $OLLAMA_URL"
echo ""
echo " Works in ANY project — no per-project setup needed."
echo ""
echo " Bootstrap brain from existing rules:"
echo "   node ~/.experience/experience-core.js --seed <memory-dir>"
echo ""
echo " Reconfigure: EXP_RESET_CONFIG=1 bash .experience/setup.sh"
echo ""
