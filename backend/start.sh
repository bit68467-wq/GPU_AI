#!/usr/bin/env bash
# Start helper for container / Render
set -e
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi
PORT=${PORT:-3000}
echo "Starting CUP9GPU demo backend on port ${PORT}"
node server.js