#!/bin/sh
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --no-audit --no-fund
PORT=${PORT:-8080} node server.js
