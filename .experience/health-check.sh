#!/bin/bash
# Experience Engine — Health Check Dashboard
# Quick diagnostic: is the engine running, reachable, and firing?
#
# Usage:
#   bash ~/.experience/health-check.sh          # full check
#   bash ~/.experience/health-check.sh --json   # machine-readable output
#   bash ~/.experience/health-check.sh --watch  # re-run every 30s

set +e  # don't exit on error — we handle failures ourselves

# ── Config ─────────────────────────────────────────────────────────────────
EXP_DIR="${HOME}/.experience"
CONFIG="$EXP_DIR/config.json"
ACTIVITY="$EXP_DIR/activity.jsonl"

# MSYS/Git Bash: convert paths for node.js (node can't read /c/Users/...)
_to_node_path() {
  local p="$1"
  if [[ "$p" == /[a-zA-Z]/* ]]; then
    # MSYS path /c/Users/... → C:/Users/...
    echo "${p:1:1}:${p:2}" | sed 's|^.|\U&|'
  else
    echo "$p"
  fi
}
CONFIG_NODE="$(_to_node_path "$CONFIG")"
ACTIVITY_NODE="$(_to_node_path "$ACTIVITY")"
JSON_MODE=false
WATCH_MODE=false

for arg in "$@"; do
  case "$arg" in
    --json)  JSON_MODE=true ;;
    --watch) WATCH_MODE=true ;;
  esac
done

# ── Helpers ────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'
DIM='\033[2m'; BOLD='\033[1m'; NC='\033[0m'

pass=0; warn=0; fail=0
declare -A results
declare -A fixes
SERVER_NODE=false

check() {
  local name="$1" status="$2" detail="${3:-}" fix="${4:-}"
  results["$name"]="$status|$detail"
  fixes["$name"]="$fix"
  case "$status" in
    ok)   ((pass++)) ;;
    warn) ((warn++)) ;;
    fail) ((fail++)) ;;
  esac
}

print_check() {
  local name="$1"
  local IFS='|'; read -r status detail <<< "${results[$name]}"
  local icon color
  case "$status" in
    ok)   icon="✓"; color="$GREEN" ;;
    warn) icon="!"; color="$YELLOW" ;;
    fail) icon="✗"; color="$RED" ;;
  esac
  printf "  ${color}${icon}${NC} %-28s %s\n" "$name" "$detail"
}

read_cfg() {
  node -e "try{const c=JSON.parse(require('fs').readFileSync('$CONFIG_NODE','utf8'));process.stdout.write(String(c['$1']||''))}catch{}" 2>/dev/null
}

# Portable HTTP status probe.
#   http_probe URL [BEARER_TOKEN] [BODY_OUTFILE]   → echoes the HTTP status code
#
# curl is tried first so the Linux/CI path is unchanged. Git-for-Windows curl
# (8.8.0, Schannel) throws CURLE_BAD_FUNCTION_ARGUMENT (43) on ANY -w/--write-out
# usage, so it can never produce a code there and falsely reports HTTP 000 even
# when the VPS is reachable. When curl yields nothing/000 we fall back to node
# fetch, which is reliable and already a hard dependency of the engine. BODY_OUTFILE
# must be a node-readable path (use _to_node_path for MSYS → drive-letter form).
http_probe() {
  local url="$1" token="${2:-}" outfile="${3:-}"
  local -a cargs=(-s -m 15 -w '%{http_code}')
  if [ -n "$outfile" ]; then cargs+=(-o "$outfile"); else cargs+=(-o /dev/null); fi
  [ -n "$token" ] && cargs+=(-H "Authorization: Bearer $token")
  local code=""
  code=$(curl "${cargs[@]}" "$url" 2>/dev/null)
  case "$code" in
    ''|000) ;;  # curl unusable here (e.g. Windows Schannel -w bug) → node fallback
    *) printf '%s' "$code"; return 0 ;;
  esac
  # The node fallback retries once on a transport error so a transient blip (the
  # write path can take a few seconds through Cloudflare) does not surface as a
  # false 000. Its stderr is intentionally dropped (2>/dev/null) to match the curl
  # calls in this file: a health probe reports failure through its status code,
  # which the dashboard prints as "HTTP <code>" alongside a suggested fix.
  EXP_PROBE_URL="$url" EXP_PROBE_TOKEN="$token" EXP_PROBE_OUT="$outfile" node -e '
    const fs = require("fs");
    const url = process.env.EXP_PROBE_URL;
    const token = process.env.EXP_PROBE_TOKEN || "";
    const out = process.env.EXP_PROBE_OUT || "";
    const headers = token ? { Authorization: "Bearer " + token } : {};
    (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
          if (out) {
            try { fs.writeFileSync(out, await r.text()); }
            catch (e) { process.stderr.write("[health-check] probe body write failed for " + url + ": " + (e && e.message) + "\n"); }
          }
          process.stdout.write(String(r.status));
          return;
        } catch (e) {
          if (attempt === 0) { await new Promise((res) => setTimeout(res, 800)); continue; }
          process.stderr.write("[health-check] probe failed for " + url + ": " + (e && e.message) + "\n");
          process.stdout.write("000");
        }
      }
    })();
  ' 2>/dev/null
}

# ── Checks ─────────────────────────────────────────────────────────────────
run_checks() {
  pass=0; warn=0; fail=0; results=(); fixes=()
  SERVER_NODE=false

  # 1. Config file
  if [ -f "$CONFIG" ]; then
    if node -e "JSON.parse(require('fs').readFileSync('$CONFIG_NODE','utf8'))" 2>/dev/null; then
      check "Config" "ok" "$CONFIG"
    else
      check "Config" "fail" "Invalid JSON: $CONFIG" "Fix config syntax or re-run setup.sh"
    fi
  else
    check "Config" "fail" "Not found: $CONFIG" "Run bash .experience/setup.sh to create config.json"
  fi

  # 2. Core files
  #
  # Thin-client never needs experience-core.js — interceptors short-circuit to
  # remote-client when serverBaseUrl is configured. Detect mode early so we
  # check the right file set.
  local _early_server_base; _early_server_base=$(read_cfg serverBaseUrl)
  local CORE_FILES=(interceptor.js interceptor-post.js interceptor-prompt.js interceptor-session.js stop-extractor.js remote-client.js health-check.sh)
  if [ -z "$_early_server_base" ]; then
    # Local / hybrid mode — experience-core.js is required
    CORE_FILES=(experience-core.js "${CORE_FILES[@]}")
  fi
  for f in "${CORE_FILES[@]}"; do
    if [ -f "$EXP_DIR/$f" ]; then
      check "$f" "ok" "$(wc -l < "$EXP_DIR/$f") lines"
    else
      check "$f" "fail" "Missing" "Re-run setup.sh so ~/.experience gets refreshed"
    fi
  done
  # In thin-client mode, surface that experience-core.js is intentionally absent.
  if [ -n "$_early_server_base" ] && [ ! -f "$EXP_DIR/experience-core.js" ]; then
    check "experience-core.js" "ok" "Not required in thin-client mode (routes through remote-client)"
  fi

  # 2a. Version drift
  #
  # Compare installCommit from config.json against the server's running commit.
  # Mismatch + age > 7 days = stale install; user should `bash upgrade.sh`.
  local install_commit; install_commit=$(read_cfg installCommit)
  local installed_at; installed_at=$(read_cfg installedAt)
  local version_server; version_server=$(read_cfg serverBaseUrl)
  if [ -n "$version_server" ]; then
    local version_resp
    version_resp=$(curl -s -m 3 "${version_server}/api/version" 2>/dev/null)
    local server_commit
    server_commit=$(echo "$version_resp" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(d).commit||'')}catch{}})" 2>/dev/null)
    if [ -z "$server_commit" ]; then
      check "Version" "warn" "Server /api/version unreachable or pre-version endpoint" "Upgrade the VPS to a build that ships /api/version, or check network"
    elif [ -z "$install_commit" ] || [ "$install_commit" = "unknown" ]; then
      check "Version" "warn" "Install predates commit stamping (server=$server_commit)" "Run bash upgrade.sh to refresh — your client cannot report its version to the server"
    elif [ "$install_commit" = "$server_commit" ]; then
      check "Version" "ok" "Installed and server both at $server_commit"
    else
      check "Version" "warn" "Client=$install_commit server=$server_commit (drift)" "Run bash upgrade.sh from your repo clone to sync"
    fi
  else
    # Local/full mode — install commit only.
    if [ -n "$install_commit" ] && [ "$install_commit" != "unknown" ]; then
      check "Version" "ok" "Installed at $install_commit${installed_at:+ ($installed_at)}"
    else
      check "Version" "warn" "Install commit not stamped" "Re-run setup.sh or sync-install.sh to record the commit"
    fi
  fi

  # 2c. Framework detection on cwd (diagnostic)
  #
  # Print what the engine would classify the current working dir as, so a dev
  # debugging "why are these hints surfacing?" gets the answer in one place.
  local cwd_now="$(pwd)"
  local cwd_node="$(_to_node_path "$cwd_now")"
  if [ -f "$EXP_DIR/source-meta-enrich.js" ]; then
    local detect_out
    detect_out=$(node -e "try{const m=require('$EXP_DIR/source-meta-enrich.js');const r=m.enrichSourceMeta({file_path:'$cwd_node'});process.stdout.write(JSON.stringify(r||{}))}catch(e){process.stdout.write('{}')}" 2>/dev/null)
    local detect_lang; detect_lang=$(echo "$detect_out" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const x=JSON.parse(d);process.stdout.write((x.lang||'(none)')+' | '+(x.framework||'(none)'))}catch{process.stdout.write('(parse failed)')}})" 2>/dev/null)
    check "Framework Detect" "ok" "cwd → $detect_lang"
  else
    check "Framework Detect" "warn" "source-meta-enrich.js missing" "Re-run setup-thin-client.sh or sync-install.sh"
  fi

  # 2b. Mode detection
  local server_base; server_base=$(read_cfg serverBaseUrl)
  local server_auth; server_auth=$(read_cfg serverAuthToken)
  local server_read_auth; server_read_auth=$(read_cfg serverReadAuthToken)
  local server_port
  server_port=$(node -e "try{const c=JSON.parse(require('fs').readFileSync('$CONFIG_NODE','utf8'));process.stdout.write(String(c.server?.port||''))}catch{}" 2>/dev/null)
  server_port="${server_port:-8082}"
  local local_server_http=""
  if [ -z "$server_base" ]; then
    local_server_http=$(curl -s -m 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${server_port}/health" 2>/dev/null)
    if [ "$local_server_http" = "200" ]; then
      SERVER_NODE=true
    fi
  fi
  if [ -n "$server_base" ]; then
    check "Mode" "ok" "Thin client → VPS brain ($server_base)"
  elif $SERVER_NODE; then
    check "Mode" "ok" "Server / brain node (http://127.0.0.1:${server_port})"
  else
    check "Mode" "ok" "Local / hybrid mode"
  fi

  # 3. SSH tunnel (if configured)
  if [ -n "$server_base" ]; then
    check "SSH Tunnel" "ok" "Not required in thin-client mode"
  else
  # Check order: process → port → Qdrant reachability (most reliable on all OS)
  local tunnel_ssh; tunnel_ssh=$(read_cfg tunnelSsh)
  if [ -n "$tunnel_ssh" ]; then
    local tunnel_port
    tunnel_port=$(echo "$tunnel_ssh" | sed -n 's/.*-L[[:space:]]*\([0-9]*\):.*/\1/p')
    if [ -n "$tunnel_port" ]; then
      # Try process check first (works on Linux/macOS/WSL)
      if ps aux 2>/dev/null | grep -v grep | grep -q "ssh.*-L.*${tunnel_port}:"; then
        check "SSH Tunnel" "ok" "Process running (port $tunnel_port)"
      # Port listening check (ss for Linux, netstat for others)
      elif ss -tlnp 2>/dev/null | grep -q ":${tunnel_port}" || netstat -an 2>/dev/null | grep -q ":${tunnel_port}.*LISTEN"; then
        check "SSH Tunnel" "ok" "Port $tunnel_port listening"
      # Fallback: if Qdrant responds on tunnel port, tunnel is alive
      elif curl -s -m 3 -H "api-key: $(read_cfg qdrantKey)" "http://localhost:${tunnel_port}/health" >/dev/null 2>&1; then
        check "SSH Tunnel" "ok" "Reachable (port $tunnel_port)"
      else
        check "SSH Tunnel" "fail" "Not running — port $tunnel_port unreachable" "Start the tunnel from config.tunnelSsh, then re-run health check"
      fi
    else
      check "SSH Tunnel" "warn" "Cannot parse port from tunnelSsh config" "Check config.tunnelSsh format: ssh ... -L localPort:host:port ..."
    fi
  else
    check "SSH Tunnel" "ok" "Not configured (direct connection)"
  fi
  fi

  # 4. Qdrant
  local qdrant_url; qdrant_url=$(read_cfg qdrantUrl)
  local qdrant_key; qdrant_key=$(read_cfg qdrantKey)
  if [ -n "$server_base" ]; then
    check "Qdrant" "ok" "Not required in thin-client mode"
  elif [ -n "$qdrant_url" ]; then
    local qdrant_resp
    qdrant_resp=$(curl -s -m 5 -w "\n%{http_code}" -H "api-key: $qdrant_key" "${qdrant_url}/collections" 2>&1)
    local qdrant_http; qdrant_http=$(echo "$qdrant_resp" | tail -1)
    if [ "$qdrant_http" = "200" ]; then
      local coll_count; coll_count=$(echo "$qdrant_resp" | head -1 | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).result.collections.length)}catch{console.log('?')}})" 2>/dev/null)
      check "Qdrant" "ok" "$qdrant_url ($coll_count collections)"
    else
      check "Qdrant" "fail" "$qdrant_url — HTTP $qdrant_http" "Check qdrantUrl / qdrantKey, or bring up the SSH tunnel / Qdrant service"
    fi
  else
    check "Qdrant" "fail" "No qdrantUrl in config" "Set qdrantUrl in ~/.experience/config.json or re-run setup.sh"
  fi

  # 5. Embed API
  local embed_provider; embed_provider=$(read_cfg embedProvider)
  local embed_endpoint; embed_endpoint=$(read_cfg embedEndpoint)
  local embed_key; embed_key=$(read_cfg embedKey)
  local embed_model; embed_model=$(read_cfg embedModel)
  if [ -n "$server_base" ]; then
    check "Embed API" "ok" "Not required in thin-client mode"
  elif [ -n "$embed_endpoint" ]; then
    local embed_resp
    embed_resp=$(curl -s -m 8 -w "\n%{http_code}" \
      -H "Authorization: Bearer $embed_key" \
      -H "Content-Type: application/json" \
      -d "{\"model\":\"$embed_model\",\"input\":[\"health check\"]}" \
      "$embed_endpoint" 2>&1)
    local embed_http; embed_http=$(echo "$embed_resp" | tail -1)
    if [ "$embed_http" = "200" ]; then
      check "Embed API" "ok" "$embed_provider ($embed_model)"
    else
      check "Embed API" "fail" "$embed_provider — HTTP $embed_http" "Check embed provider credentials/model/endpoint, then re-run setup.sh if needed"
    fi
  elif [ "$embed_provider" = "ollama" ]; then
    local ollama_url; ollama_url=$(read_cfg ollamaUrl)
    ollama_url="${ollama_url:-http://localhost:11434}"
    if curl -s -m 5 "$ollama_url/api/tags" >/dev/null 2>&1; then
      check "Embed API" "ok" "Ollama ($embed_model)"
    else
      check "Embed API" "fail" "Ollama unreachable at $ollama_url" "Start Ollama and ensure the embedding model is pulled"
    fi
  else
    check "Embed API" "warn" "Cannot verify ($embed_provider)" "If embeddings fail in practice, validate embedEndpoint/embedKey manually"
  fi

  # 6. Brain API
  local brain_provider; brain_provider=$(read_cfg brainProvider)
  local brain_endpoint; brain_endpoint=$(read_cfg brainEndpoint)
  local brain_proxy; brain_proxy=$(read_cfg brainProxyUrl)
  if [ -n "$server_base" ]; then
    check "Brain API" "ok" "Not required in thin-client mode"
  elif [ -n "$brain_endpoint" ]; then
    # Light check — just verify endpoint responds (don't burn tokens)
    local brain_http
    brain_http=$(curl -s -m 5 -o /dev/null -w "%{http_code}" \
      -H "Authorization: Bearer $(read_cfg brainKey)" \
      -H "Content-Type: application/json" \
      -d '{"model":"'"$(read_cfg brainModel)"'","messages":[{"role":"user","content":"ping"}],"max_tokens":1}' \
      "$brain_endpoint" 2>&1)
    if [ "$brain_http" = "200" ]; then
      check "Brain API" "ok" "$brain_provider ($(read_cfg brainModel))"
    else
      check "Brain API" "warn" "$brain_provider — HTTP $brain_http (may still work via proxy)" "Check brain credentials or set brainProxyUrl/serverBaseUrl if the model is only reachable via VPS"
    fi
  else
    check "Brain API" "warn" "No endpoint configured" "Set brainEndpoint/brainKey or use brainProxyUrl through the VPS"
  fi

  # 6b. Remote thin-client checks
  if [ -n "$server_base" ]; then
    local server_health_http
    local health_body="$EXP_DIR/.exp-health-$$.json"
    local health_body_node; health_body_node="$(_to_node_path "$health_body")"
    server_health_http=$(http_probe "${server_base}/health" "" "$health_body_node")
    if [ "$server_health_http" = "200" ]; then
      local server_status
      server_status=$(node -e "try{const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(d.status||'unknown')}catch{process.stdout.write('unknown')}" "$health_body_node" 2>/dev/null)
      check "Remote Server" "ok" "$server_base (status=$server_status)"
    else
      check "Remote Server" "fail" "$server_base — HTTP $server_health_http" "Bring up the VPS server or fix serverBaseUrl; test with curl ${server_base}/health"
    fi
    rm -f "$health_body" 2>/dev/null

    local gates_http
    local gates_token="$server_read_auth"
    [ -z "$gates_token" ] && gates_token="$server_auth"
    gates_http=$(http_probe "${server_base}/api/gates" "$gates_token")
    if [ "$gates_http" = "000" ]; then
      sleep 1
      gates_http=$(http_probe "${server_base}/api/gates" "$gates_token")
    fi
    if [ "$gates_http" = "200" ]; then
      check "Remote Gates" "ok" "$server_base/api/gates"
    elif [ "$gates_http" = "401" ]; then
      check "Remote Gates" "warn" "$server_base/api/gates — HTTP 401" "Set serverReadAuthToken (preferred) or serverAuthToken in ~/.experience/config.json"
    else
      check "Remote Gates" "warn" "$server_base/api/gates — HTTP $gates_http" "Upgrade the VPS runtime or verify serverBaseUrl/token configuration"
    fi

    if [ -n "$server_read_auth" ]; then
      check "Server Auth" "ok" "Read token configured for observability; full token optional for writes"
    elif [ -n "$server_auth" ]; then
      check "Server Auth" "ok" "Full bearer token configured"
    else
      check "Server Auth" "warn" "No serverAuthToken/serverReadAuthToken configured" "Set serverReadAuthToken for /api/stats and /api/gates, or serverAuthToken for full access"
    fi
  else
    check "Remote Server" "ok" "Not configured (local/hybrid mode)"
    check "Remote Gates" "ok" "Not configured (local/hybrid mode)"
    check "Server Auth" "ok" "Not required in local/hybrid mode"
  fi

  # 7. Agent hooks
  check_agent_hooks "Claude Code" "$HOME/.claude/settings.json" "PreToolUse" "interceptor"
  check_agent_hooks "Codex CLI" "$HOME/.codex/hooks.json" "PreToolUse" "interceptor"
  check_agent_hooks "Gemini CLI" "$HOME/.gemini/settings.json" "BeforeTool" "interceptor"

  # 8. Activity — recent intercepts
  if [ -n "$server_base" ]; then
    check "Activity" "ok" "Thin-client mode — activity is tracked on VPS"
    check "Model Routing" "ok" "Tracked on VPS"
  elif [ -f "$ACTIVITY" ]; then
    local total_lines; total_lines=$(wc -l < "$ACTIVITY")
    local last_ts; last_ts=$(tail -1 "$ACTIVITY" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).ts)}catch{console.log('?')}})" 2>/dev/null)
    local intercept_count; intercept_count=$(grep -c '"op":"intercept"' "$ACTIVITY" 2>/dev/null || true); intercept_count="${intercept_count:-0}"
    local suggestion_count; suggestion_count=$(grep -c '"result":"suggestion"' "$ACTIVITY" 2>/dev/null || true); suggestion_count="${suggestion_count:-0}"
    local route_count; route_count=$(grep -c '"op":"route"' "$ACTIVITY" 2>/dev/null || true); route_count="${route_count:-0}"

    if [ -n "$last_ts" ] && [ "$last_ts" != "?" ]; then
      # Check staleness
      local last_epoch; last_epoch=$(node -e "console.log(Math.floor(new Date('$last_ts').getTime()/1000))" 2>/dev/null || echo "0")
      local now_epoch; now_epoch=$(date +%s)
      local age_min=$(( (now_epoch - last_epoch) / 60 ))

      if [ "$age_min" -lt 60 ]; then
        check "Activity" "ok" "${intercept_count} intercepts, ${suggestion_count} suggestions, last ${age_min}m ago"
      elif [ "$age_min" -lt 1440 ]; then
        check "Activity" "warn" "Last activity ${age_min}m ago (${intercept_count} intercepts total)" "Run an agent with hooks enabled, then re-check. If using thin-client mode, verify VPS receives events"
      else
        check "Activity" "warn" "Last activity $(( age_min / 1440 ))d ago — hooks may not be firing" "Re-run setup.sh to wire hooks, then trigger one tool call and re-check"
      fi
    else
      check "Activity" "warn" "$total_lines entries but cannot parse timestamp" "Inspect activity.jsonl for malformed lines or rotate the file"
    fi

    # Routing stats
    if [ "$route_count" -gt 0 ]; then
      check "Model Routing" "ok" "$route_count route decisions logged"
    else
      local routing_enabled; routing_enabled=$(read_cfg routing)
      if [ "$routing_enabled" = "true" ]; then
        check "Model Routing" "warn" "Enabled but 0 route entries — may be too new" "Use the model router once or confirm router events reach the VPS/local activity log"
      else
        check "Model Routing" "ok" "Disabled (config.routing != true)"
      fi
    fi
  else
    check "Activity" "warn" "No activity.jsonl — engine hasn't fired yet" "Run one hooked agent session, or in thin-client mode confirm the VPS is the source of truth"
    check "Model Routing" "warn" "No activity data" "Generate one route decision or disable routing in config if unused"
  fi

  # 9. Offline queue
  local queue_dir="$EXP_DIR/offline-queue"
  if [ -d "$queue_dir" ]; then
    local queue_count; queue_count=$(find "$queue_dir" -maxdepth 1 -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
    if [ "${queue_count:-0}" -eq 0 ]; then
      check "Offline Queue" "ok" "Empty"
    elif [ "${queue_count:-0}" -lt 20 ]; then
      check "Offline Queue" "warn" "$queue_count queued event(s)" "Restore VPS reachability and run one hook/event to flush the queue"
    else
      check "Offline Queue" "fail" "$queue_count queued event(s)" "The client cannot reach the VPS; fix serverBaseUrl/auth/network, then replay by running a hook"
    fi
  else
    check "Offline Queue" "ok" "Not created yet"
  fi

  # 10. Portable migration tools
  #
  # These talk to local Qdrant + FileStore — useless in thin-client mode where
  # the brain lives on the VPS. Skip the check when serverBaseUrl is set.
  if [ -n "$_early_server_base" ]; then
    check "Portable Backup" "ok" "Not required in thin-client mode (brain lives on VPS)"
  else
    local missing_tools=()
    for f in "$EXP_DIR/exp-server-maintain.js" "$EXP_DIR/exp-portable-backup.js" "$EXP_DIR/exp-portable-restore.js"; do
      [ -f "$f" ] || missing_tools+=("$(basename "$f")")
    done
    if [ "${#missing_tools[@]}" -eq 0 ]; then
      check "Portable Backup" "ok" "Maintenance and backup tools present"
    else
      check "Portable Backup" "warn" "Missing: ${missing_tools[*]}" "Update the repo checkout so VPS maintenance/backup scripts are available"
    fi
  fi

  # 11. Session Sync staleness
  #
  # Checks .last-sync.json written by upgrade.sh after bulk-extract runs.
  # Warns if no sync has happened in >7 days — brain may be missing recent
  # experiences from local Claude/Codex/Gemini sessions.
  local sync_file="$EXP_DIR/.last-sync.json"
  if [ -f "$sync_file" ]; then
    local sync_ts; sync_ts=$(node -e "try{const d=JSON.parse(require('fs').readFileSync('$(_to_node_path "$sync_file")','utf8'));process.stdout.write(d.ts||'')}catch{}" 2>/dev/null)
    if [ -n "$sync_ts" ]; then
      local sync_epoch; sync_epoch=$(node -e "console.log(Math.floor(new Date('$sync_ts').getTime()/1000))" 2>/dev/null || echo "0")
      local now_epoch; now_epoch=$(date +%s)
      local sync_age_days=$(( (now_epoch - sync_epoch) / 86400 ))
      if [ "$sync_age_days" -lt 7 ]; then
        check "Session Sync" "ok" "Last sync ${sync_age_days}d ago ($sync_ts)"
      elif [ "$sync_age_days" -lt 30 ]; then
        check "Session Sync" "warn" "Last sync ${sync_age_days}d ago — brain may be stale" "Run: bash upgrade.sh --sync-only"
      else
        check "Session Sync" "warn" "Last sync ${sync_age_days}d ago — brain is stale" "Run: bash upgrade.sh --sync-only"
      fi
    else
      check "Session Sync" "warn" "Sync file exists but timestamp unreadable" "Run: bash upgrade.sh --sync-only"
    fi
  else
    check "Session Sync" "warn" "Never synced — brain has no local session data" "Run: bash upgrade.sh --sync-only"
  fi
}

check_agent_hooks() {
  local name="$1" file="$2" event="$3" needle="$4"
  if $SERVER_NODE; then
    check "$name hooks" "ok" "Not required on server node"
    return
  fi
  if [ ! -f "$file" ]; then
    check "$name hooks" "ok" "Not installed (no config file)"
    return
  fi
  # Substring match without grep: Git-for-Windows MinGit bash ships no grep, so a
  # `grep -q` here exits 127 and falsely reports every hook as unwired on Windows.
  # `$(<file)` + case globbing is a pure-bash equivalent that works everywhere.
  local content=""
  content="$(<"$file")"
  case "$content" in
    *"$needle"*) check "$name hooks" "ok" "Wired ($event)" ;;
    *)           check "$name hooks" "fail" "Config exists but no $needle hook" "Re-run setup.sh and include $name in the selected agents" ;;
  esac
}

# ── Output ─────────────────────────────────────────────────────────────────
print_dashboard() {
  local ts; ts=$(date '+%Y-%m-%d %H:%M:%S')
  echo ""
  printf "  ${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
  printf "  ${BOLD} Experience Engine — Health Check${NC}\n"
  printf "  ${DIM} $ts${NC}\n"
  printf "  ${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
  echo ""

  printf "  ${CYAN}${BOLD}Infrastructure${NC}\n"
  print_check "Config"
  print_check "Version"
  print_check "Framework Detect"
  print_check "SSH Tunnel"
  print_check "Qdrant"
  print_check "Embed API"
  print_check "Brain API"
  print_check "Remote Server"
  print_check "Remote Gates"
  print_check "Server Auth"
  echo ""

  printf "  ${CYAN}${BOLD}Core Files${NC}\n"
  print_check "experience-core.js"
  print_check "interceptor.js"
  print_check "interceptor-post.js"
  print_check "interceptor-prompt.js"
  print_check "interceptor-session.js"
  print_check "stop-extractor.js"
  print_check "remote-client.js"
  print_check "health-check.sh"
  echo ""

  printf "  ${CYAN}${BOLD}Agent Hooks${NC}\n"
  print_check "Claude Code hooks"
  print_check "Codex CLI hooks"
  print_check "Gemini CLI hooks"
  echo ""

  printf "  ${CYAN}${BOLD}Runtime${NC}\n"
  print_check "Mode"
  print_check "Activity"
  print_check "Model Routing"
  print_check "Offline Queue"
  print_check "Portable Backup"
  print_check "Session Sync"
  echo ""

  # Summary
  local total=$((pass + warn + fail))
  if [ "$fail" -eq 0 ] && [ "$warn" -eq 0 ]; then
    printf "  ${GREEN}${BOLD}All $total checks passed${NC}\n"
  elif [ "$fail" -eq 0 ]; then
    printf "  ${GREEN}${BOLD}$pass passed${NC}, ${YELLOW}${BOLD}$warn warnings${NC}\n"
  else
    printf "  ${GREEN}$pass passed${NC}, ${YELLOW}$warn warnings${NC}, ${RED}${BOLD}$fail failed${NC}\n"
  fi
  echo ""

  # Quick fixes for failures and warnings
  if [ "$fail" -gt 0 ] || [ "$warn" -gt 0 ]; then
    printf "  ${BOLD}Suggested fixes:${NC}\n"
    for name in "${!results[@]}"; do
      local IFS='|'; read -r status detail <<< "${results[$name]}"
      if [ "$status" = "fail" ] || [ "$status" = "warn" ]; then
        local fix="${fixes[$name]}"
        if [ -n "$fix" ]; then
          printf "    ${DIM}$name: $fix${NC}\n"
        else
          printf "    ${DIM}$name: $detail${NC}\n"
        fi
      fi
    done
    echo ""
  fi
}

print_json() {
  local json_results="{"
  local first=true
  for name in "${!results[@]}"; do
    local IFS='|'; read -r status detail <<< "${results[$name]}"
    $first || json_results+=","
    first=false
    # Escape quotes in detail
    detail="${detail//\"/\\\"}"
    local fix="${fixes[$name]}"
    fix="${fix//\"/\\\"}"
    json_results+="\"$(echo "$name" | tr ' ' '_' | tr '[:upper:]' '[:lower:]')\":{\"status\":\"$status\",\"detail\":\"$detail\",\"fix\":\"$fix\"}"
  done
  json_results+=",\"summary\":{\"pass\":$pass,\"warn\":$warn,\"fail\":$fail}}"
  echo "$json_results"
}

# ── Main ───────────────────────────────────────────────────────────────────
if $WATCH_MODE; then
  while true; do
    clear
    run_checks
    print_dashboard
    printf "  ${DIM}Refreshing in 30s... (Ctrl+C to stop)${NC}\n"
    sleep 30
  done
else
  run_checks
  if $JSON_MODE; then
    print_json
  else
    print_dashboard
  fi
  exit "$fail"
fi
