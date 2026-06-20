#!/usr/bin/env bash
# Single command that runs every Phase 1 gate. CI calls this; humans can too.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Backend test suite"
cd "$ROOT/backend"
.venv/bin/python -m pytest tests/ -v --strict-markers

echo "==> Frontend type-check"
cd "$ROOT/frontend"
./node_modules/.bin/tsc --noEmit

echo "==> Frontend unit tests (vitest)"
./node_modules/.bin/vitest run --reporter=basic

echo "==> Frontend build"
./node_modules/.bin/vite build

echo "==> All gates green."
