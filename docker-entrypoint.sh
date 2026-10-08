#!/bin/sh
# Run the server as the unprivileged "node" user.
#
# Images before 0.9 ran as root with the data volume at /root/.experience, so
# an upgraded experience_data volume is still root-owned. When started as root,
# hand the data dir to "node" (only if it is not already) and drop privileges.
set -e

DATA_DIR="${HOME:-/home/node}/.experience"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR/store/default"
  if [ "$(stat -c %U "$DATA_DIR")" != "node" ] || [ -n "$(find "$DATA_DIR" ! -user node -print -quit)" ]; then
    chown -R node:node "$DATA_DIR"
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

mkdir -p "$DATA_DIR/store/default"
exec "$@"
