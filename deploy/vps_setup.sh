#!/usr/bin/env bash
# vps_setup.sh
#
# Hybrid Experience Engine Architecture - VPS Ollama Setup Script
#
# This script initializes the remote VPS:
# 1. Installs Ollama via official installer.
# 2. Configures Ollama systemd service with secure overrides (binds to 127.0.0.1).
# 3. Restarts and enables Ollama service.
# 4. Pulls qwen2.5-coder:1.5b and qwen2.5-coder:7b models.
#
# Usage:
#   chmod +x vps_setup.sh
#   ./vps_setup.sh (usually run as 'phila' user with sudo privileges)

set -euo pipefail

# --- Configuration ---
OLLAMA_HOST="127.0.0.1"      # Force Ollama to bind only to localhost for SSH tunnel security
OLLAMA_PORT="11434"
MODELS=("qwen2.5-coder:1.5b" "qwen2.5-coder:7b")

# Helper: Log messages
log() {
  echo -e "\x1b[32m[$(date +'%Y-%m-%dT%H:%M:%S')] $1\x1b[0m"
}

log_error() {
  echo -e "\x1b[31m[$(date +'%Y-%m-%dT%H:%M:%S')] [ERROR] $1\x1b[0m" >&2
}

# 1. Prerequisites Check
log "Checking prerequisites..."
if ! command -v curl &>/dev/null; then
  log "Installing curl..."
  sudo apt-get update && sudo apt-get install -y curl
fi

if ! command -v systemctl &>/dev/null; then
  log_error "systemd is not available. This script requires systemd to manage Ollama service."
  exit 1
fi

# 2. Install Ollama
if ! command -v ollama &>/dev/null; then
  log "Ollama not found. Starting installation..."
  # Run official Ollama install script with sudo
  curl -fsSL https://ollama.com/install.sh | sudo sh
else
  log "Ollama is already installed: $(ollama --version)"
fi

# 3. Configure systemd Service Override
log "Configuring systemd service override for Ollama..."
OVERRIDE_DIR="/etc/systemd/system/ollama.service.d"
OVERRIDE_FILE="${OVERRIDE_DIR}/override.conf"

# Ensure override directory exists
sudo mkdir -p "$OVERRIDE_DIR"

# Write override settings
# Binds Ollama strictly to 127.0.0.1 so it cannot be accessed directly from the WAN.
# Only local ssh tunnels will be allowed to bridge to it.
sudo tee "$OVERRIDE_FILE" > /dev/null <<EOF
[Service]
Environment="OLLAMA_HOST=${OLLAMA_HOST}:${OLLAMA_PORT}"
Environment="OLLAMA_NUM_PARALLEL=4"
Environment="OLLAMA_MAX_LOADED_MODELS=2"
EOF

log "Reloading systemd daemon..."
sudo systemctl daemon-reload

log "Enabling and restarting Ollama service..."
sudo systemctl enable ollama
sudo systemctl restart ollama

# 4. Verify Ollama Health
log "Verifying Ollama service is responsive..."
OLLAMA_API_URL="http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/tags"
VERIFY_TIMEOUT=30
VERIFIED=false

for ((i=1; i<=VERIFY_TIMEOUT; i++)); do
  if curl -s -o /dev/null -w "%{http_code}" "$OLLAMA_API_URL" | grep -q "200"; then
    VERIFIED=true
    break
  fi
  log "Waiting for Ollama API to respond... ($i/$VERIFY_TIMEOUT)"
  sleep 1
done

if [ "$VERIFIED" = false ]; then
  log_error "Ollama service failed to respond on ${OLLAMA_HOST}:${OLLAMA_PORT} within ${VERIFY_TIMEOUT} seconds."
  sudo systemctl status ollama --no-pager
  exit 1
fi

log "Ollama service is up and running!"

# 5. Pull LLM Models
for model in "${MODELS[@]}"; do
  log "Pulling model: ${model} (this may take a few minutes)..."
  if ollama pull "$model"; then
    log "Successfully pulled model: ${model}"
  else
    log_error "Failed to pull model: ${model}"
    exit 1
  fi
done

log "VPS Ollama setup complete! System is ready to accept SSH tunnels."
