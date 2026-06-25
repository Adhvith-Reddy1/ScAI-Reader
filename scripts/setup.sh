#!/usr/bin/env bash
# One-time setup: create the Python venv, install backend + frontend deps,
# and build the frontend. Safe to re-run — it's idempotent.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

# --- Find a Python >= 3.12 -------------------------------------------------
find_python() {
  for cand in python3.13 python3.12 python3 python; do
    if command -v "$cand" >/dev/null 2>&1; then
      ver="$("$cand" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo 0.0)"
      major="${ver%%.*}"; minor="${ver##*.}"
      if [ "$major" -eq 3 ] && [ "$minor" -ge 12 ]; then
        echo "$cand"; return 0
      fi
    fi
  done
  return 1
}

say "Checking prerequisites"
PYTHON="$(find_python)" || die "Python 3.12+ is required but was not found.
Install it from https://www.python.org/downloads/ (or 'brew install python@3.12')."
echo "Python: $("$PYTHON" --version) ($PYTHON)"

command -v npm >/dev/null 2>&1 || die "npm (Node.js) is required but was not found.
Install Node 18+ from https://nodejs.org/."
echo "Node:   $(node --version)"
echo "npm:    $(npm --version)"

# --- Backend ---------------------------------------------------------------
say "Setting up backend (Python venv + dependencies)"
cd "$ROOT/backend"
if [ ! -d .venv ]; then
  "$PYTHON" -m venv .venv
  echo "Created backend/.venv"
fi
./.venv/bin/python -m pip install --quiet --upgrade pip
# Install runtime deps. Pass --dev to also install the test toolchain.
if [ "${1:-}" = "--dev" ]; then
  ./.venv/bin/pip install --quiet -e ".[test]"
  echo "Installed backend runtime + test dependencies"
else
  ./.venv/bin/pip install --quiet -e .
  echo "Installed backend runtime dependencies (use --dev for tests)"
fi

# --- Frontend --------------------------------------------------------------
say "Setting up frontend (npm install + build)"
cd "$ROOT/frontend"
npm install --no-audit --no-fund
npm run build
echo "Built frontend → frontend/dist"

# --- .env scaffold ---------------------------------------------------------
cd "$ROOT"
if [ ! -f .env ]; then
  cp .env.example .env
  say "Created .env from .env.example"
  echo "Add your ANTHROPIC_API_KEY to .env to enable AI features (optional)."
fi

say "Setup complete"
echo "Start the app with:  ./scripts/run.sh"
