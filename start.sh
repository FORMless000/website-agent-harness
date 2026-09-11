#!/bin/sh
# Run from this script's directory; the server loads .env itself.
set -eu
cd -- "$(dirname -- "$0")"

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 20.20+ and npm are required." >&2
  exit 1
fi
if [ ! -d node_modules/tsx ]; then
  echo "Dependencies are missing. Run npm ci in this directory first." >&2
  exit 1
fi

exec npm start -- "$@"
