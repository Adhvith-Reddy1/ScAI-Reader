#!/usr/bin/env bash
# Start ScAI-Reader as a single local server (backend serves the built
# frontend). Runs setup automatically on first launch. Open the printed URL.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

PORT="${PORT:-8000}"

# First-run / incomplete setup → run setup.sh.
if [ ! -d backend/.venv ] || [ ! -d frontend/dist ]; then
  say "First run — installing and building (this happens once)"
  ./scripts/setup.sh
fi

# Rebuild the frontend if sources changed since the last build.
if [ -n "$(find frontend/src frontend/index.html -newer frontend/dist/index.html 2>/dev/null)" ]; then
  say "Frontend sources changed — rebuilding"
  (cd frontend && npm run build)
fi

# Surface whether AI features will be on (run.sh exports .env so a directly
# launched uvicorn or this banner both see it; the app also loads .env itself).
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  AI="enabled"
else
  AI="disabled (set ANTHROPIC_API_KEY in .env to enable)"
fi

URL="http://localhost:${PORT}"

say "Starting ScAI-Reader"
echo "  URL:          ${URL}"
echo "  AI features:  ${AI}"
echo "  Stop:         Ctrl-C"
echo

# Open the browser once the server is accepting connections (best-effort).
# Set NO_OPEN=1 to skip (e.g. on a headless machine).
if [ "${NO_OPEN:-0}" != "1" ]; then
  ( for _ in $(seq 1 40); do
      if curl -fsS "${URL}/healthz" >/dev/null 2>&1; then
        if command -v open >/dev/null 2>&1; then open "$URL"          # macOS
        elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" # Linux
        elif command -v powershell.exe >/dev/null 2>&1; then powershell.exe -NoProfile start "$URL"  # Windows/WSL
        fi
        break
      fi
      sleep 0.5
    done ) >/dev/null 2>&1 &
fi

cd backend
exec ./.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "$PORT"
