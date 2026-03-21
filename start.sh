#!/usr/bin/env bash
# Simple start helper for local testing
set -e
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi
echo "Starting CUP9GPU demo backend on port ${PORT:-3000}"
node server.js