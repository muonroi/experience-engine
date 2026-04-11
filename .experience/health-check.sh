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

check() {
  local name="$1" status="$2" detail="${3:-}"
  results["$name"]="$status|$detail"
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

# ── Checks ─────────────────────────────────────────────────────────────────
run_checks() {
  pass=0; warn=0; fail=0; results=()

  # 1. Config file
  if [ -f "$CONFIG" ]; then
    if node -e "JSON.parse(require('fs').readFileSync('$CONFIG_NODE','utf8'))" 2>/dev/null; then
      check "Config" "ok" "$CONFIG"
    else
      check "Config" "fail" "Invalid JSON: $CONFIG"
    fi
  else
    check "Config" "fail" "Not found: $CONFIG"
  fi

  # 2. Core files
  for f in experience-core.js interceptor.js interceptor-post.js stop-extractor.js; do
    if [ -f "$EXP_DIR/$f" ]; then
      check "$f" "ok" "$(wc -l < "$EXP_DIR/$f") lines"
    else
      check "$f" "fail" "Missing"
    fi
  done

  # 3. SSH tunnel (if configured)
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
        check "SSH Tunnel" "fail" "Not running — port $tunnel_port unreachable"
      fi
    else
      check "SSH Tunnel" "warn" "Cannot parse port from tunnelSsh config"
    fi
  else
    check "SSH Tunnel" "ok" "Not configured (direct connection)"
  fi

  # 4. Qdrant
  local qdrant_url; qdrant_url=$(read_cfg qdrantUrl)
  local qdrant_key; qdrant_key=$(read_cfg qdrantKey)
  if [ -n "$qdrant_url" ]; then
    local qdrant_resp
    qdrant_resp=$(curl -s -m 5 -w "\n%{http_code}" -H "api-key: $qdrant_key" "${qdrant_url}/collections" 2>&1)
    local qdrant_http; qdrant_http=$(echo "$qdrant_resp" | tail -1)
    if [ "$qdrant_http" = "200" ]; then
      local coll_count; coll_count=$(echo "$qdrant_resp" | head -1 | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).result.collections.length)}catch{console.log('?')}})" 2>/dev/null)
      check "Qdrant" "ok" "$qdrant_url ($coll_count collections)"
    else
      check "Qdrant" "fail" "$qdrant_url — HTTP $qdrant_http"
    fi
  else
    check "Qdrant" "fail" "No qdrantUrl in config"
  fi

  # 5. Embed API
  local embed_provider; embed_provider=$(read_cfg embedProvider)
  local embed_endpoint; embed_endpoint=$(read_cfg embedEndpoint)
  local embed_key; embed_key=$(read_cfg embedKey)
  local embed_model; embed_model=$(read_cfg embedModel)
  if [ -n "$embed_endpoint" ]; then
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
      check "Embed API" "fail" "$embed_provider — HTTP $embed_http"
    fi
  elif [ "$embed_provider" = "ollama" ]; then
    local ollama_url; ollama_url=$(read_cfg ollamaUrl)
    ollama_url="${ollama_url:-http://localhost:11434}"
    if curl -s -m 5 "$ollama_url/api/tags" >/dev/null 2>&1; then
      check "Embed API" "ok" "Ollama ($embed_model)"
    else
      check "Embed API" "fail" "Ollama unreachable at $ollama_url"
    fi
  else
    check "Embed API" "warn" "Cannot verify ($embed_provider)"
  fi

  # 6. Brain API
  local brain_provider; brain_provider=$(read_cfg brainProvider)
  local brain_endpoint; brain_endpoint=$(read_cfg brainEndpoint)
  local brain_proxy; brain_proxy=$(read_cfg brainProxyUrl)
  if [ -n "$brain_endpoint" ]; then
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
      check "Brain API" "warn" "$brain_provider — HTTP $brain_http (may still work via proxy)"
    fi
  else
    check "Brain API" "warn" "No endpoint configured"
  fi

  # 7. Agent hooks
  check_agent_hooks "Claude Code" "$HOME/.claude/settings.json" "PreToolUse" "interceptor"
  check_agent_hooks "Codex CLI" "$HOME/.codex/hooks.json" "PreToolUse" "interceptor"
  check_agent_hooks "Gemini CLI" "$HOME/.gemini/settings.json" "BeforeTool" "interceptor"

  # 8. Activity — recent intercepts
  if [ -f "$ACTIVITY" ]; then
    local total_lines; total_lines=$(wc -l < "$ACTIVITY")
    local last_ts; last_ts=$(tail -1 "$ACTIVITY" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).ts)}catch{console.log('?')}})" 2>/dev/null)
    local intercept_count; intercept_count=$(grep -c '"op":"intercept"' "$ACTIVITY" 2>/dev/null || echo "0")
    local suggestion_count; suggestion_count=$(grep -c '"result":"suggestion"' "$ACTIVITY" 2>/dev/null || echo "0")
    local route_count; route_count=$(grep -c '"op":"route"' "$ACTIVITY" 2>/dev/null || echo "0")

    if [ -n "$last_ts" ] && [ "$last_ts" != "?" ]; then
      # Check staleness
      local last_epoch; last_epoch=$(node -e "console.log(Math.floor(new Date('$last_ts').getTime()/1000))" 2>/dev/null || echo "0")
      local now_epoch; now_epoch=$(date +%s)
      local age_min=$(( (now_epoch - last_epoch) / 60 ))

      if [ "$age_min" -lt 60 ]; then
        check "Activity" "ok" "${intercept_count} intercepts, ${suggestion_count} suggestions, last ${age_min}m ago"
      elif [ "$age_min" -lt 1440 ]; then
        check "Activity" "warn" "Last activity ${age_min}m ago (${intercept_count} intercepts total)"
      else
        check "Activity" "warn" "Last activity $(( age_min / 1440 ))d ago — hooks may not be firing"
      fi
    else
      check "Activity" "warn" "$total_lines entries but cannot parse timestamp"
    fi

    # Routing stats
    if [ "$route_count" -gt 0 ]; then
      check "Model Routing" "ok" "$route_count route decisions logged"
    else
      local routing_enabled; routing_enabled=$(read_cfg routing)
      if [ "$routing_enabled" = "true" ]; then
        check "Model Routing" "warn" "Enabled but 0 route entries — may be too new"
      else
        check "Model Routing" "ok" "Disabled (config.routing != true)"
      fi
    fi
  else
    check "Activity" "warn" "No activity.jsonl — engine hasn't fired yet"
    check "Model Routing" "warn" "No activity data"
  fi
}

check_agent_hooks() {
  local name="$1" file="$2" event="$3" needle="$4"
  if [ ! -f "$file" ]; then
    check "$name hooks" "ok" "Not installed (no config file)"
    return
  fi
  if grep -q "$needle" "$file" 2>/dev/null; then
    check "$name hooks" "ok" "Wired ($event)"
  else
    check "$name hooks" "fail" "Config exists but no $needle hook"
  fi
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
  print_check "SSH Tunnel"
  print_check "Qdrant"
  print_check "Embed API"
  print_check "Brain API"
  echo ""

  printf "  ${CYAN}${BOLD}Core Files${NC}\n"
  print_check "experience-core.js"
  print_check "interceptor.js"
  print_check "interceptor-post.js"
  print_check "stop-extractor.js"
  echo ""

  printf "  ${CYAN}${BOLD}Agent Hooks${NC}\n"
  print_check "Claude Code hooks"
  print_check "Codex CLI hooks"
  print_check "Gemini CLI hooks"
  echo ""

  printf "  ${CYAN}${BOLD}Runtime${NC}\n"
  print_check "Activity"
  print_check "Model Routing"
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

  # Quick fixes for failures
  if [ "$fail" -gt 0 ]; then
    printf "  ${BOLD}Quick fixes:${NC}\n"
    for name in "${!results[@]}"; do
      local IFS='|'; read -r status detail <<< "${results[$name]}"
      if [ "$status" = "fail" ]; then
        case "$name" in
          "SSH Tunnel")
            local tunnel_ssh; tunnel_ssh=$(read_cfg tunnelSsh)
            printf "    ${DIM}$name: $tunnel_ssh${NC}\n" ;;
          "Qdrant")
            printf "    ${DIM}$name: Check tunnel or qdrantUrl in config.json${NC}\n" ;;
          *hooks*)
            printf "    ${DIM}$name: Re-run setup.sh to wire hooks${NC}\n" ;;
          *)
            printf "    ${DIM}$name: $detail${NC}\n" ;;
        esac
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
    json_results+="\"$(echo "$name" | tr ' ' '_' | tr '[:upper:]' '[:lower:]')\":{\"status\":\"$status\",\"detail\":\"$detail\"}"
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
