#!/bin/bash
# Experience Engine shell init
# Keeps helper PATH available, triggers background bootstrap, and prints the last known status.

case $- in
  *i*) ;;
  *) return 0 2>/dev/null || exit 0 ;;
esac

EXP_DIR="${HOME}/.experience"
LOCAL_BIN="${HOME}/.local/bin"
BOOTSTRAP="$EXP_DIR/exp-bootstrap.sh"
STATUS_CMD="$EXP_DIR/exp-health-last"
LATEST_META="$EXP_DIR/status/boot-health-latest.meta.json"

case ":$PATH:" in
  *":$LOCAL_BIN:"*) ;;
  *) export PATH="$LOCAL_BIN:$PATH" ;;
esac

if [ -x "$BOOTSTRAP" ] && [ -z "${EXP_ENGINE_BOOTSTRAP_STARTED:-}" ]; then
  export EXP_ENGINE_BOOTSTRAP_STARTED=1
  nohup "$BOOTSTRAP" --reason shell-open --quiet >/dev/null 2>&1 &
fi

if [ -z "${EXP_ENGINE_HEALTH_SHOWN:-}" ]; then
  export EXP_ENGINE_HEALTH_SHOWN=1
  if [ -x "$STATUS_CMD" ]; then
    "$STATUS_CMD" --brief 2>/dev/null
  elif [ ! -f "$LATEST_META" ]; then
    echo "Experience Engine boot check pending"
  fi
fi
