#!/usr/bin/env bash
# One-shot installer for ScAI-Reader. Designed to be runnable two ways:
#
#   1. From a clone:      ./scripts/install.sh
#   2. Piped from the web:
#        curl -fsSL https://raw.githubusercontent.com/Adhvith-Reddy1/ScAI-Reader/main/scripts/install.sh | bash
#
# It checks prerequisites, clones the repo if needed, installs everything,
# and tells you how to start. No prior setup required beyond Python and Node.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Adhvith-Reddy1/ScAI-Reader.git}"
BRANCH="${BRANCH:-main}"
TARGET_DIR="${TARGET_DIR:-$HOME/ScAI-Reader}"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$1"; }
die()  { printf '\n\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

# --- Prerequisites with friendly, OS-aware install hints --------------------
have_python() {
  for c in python3.13 python3.12 python3 python; do
    if command -v "$c" >/dev/null 2>&1; then
      v="$("$c" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo 0.0)"
      [ "${v%%.*}" -eq 3 ] && [ "${v##*.}" -ge 12 ] && return 0
    fi
  done
  return 1
}

say "Checking prerequisites"
if ! have_python; then
  die "Python 3.12 or newer is required.
  macOS:   brew install python@3.12   (or download from https://www.python.org/downloads/)
  Windows: install from https://www.python.org/downloads/  (check 'Add to PATH')
  Linux:   sudo apt install python3.12 python3.12-venv   (or your distro's package)"
fi
ok "Python $(have_python >/dev/null; for c in python3.13 python3.12 python3; do command -v $c >/dev/null && { $c --version; break; }; done)"

command -v git >/dev/null 2>&1 || die "git is required. Install it from https://git-scm.com/downloads"
ok "git $(git --version | awk '{print $3}')"

command -v npm >/dev/null 2>&1 || die "Node.js (npm) is required. Install Node 18+ from https://nodejs.org/"
ok "Node $(node --version)"

# --- Locate or clone the repo ----------------------------------------------
if [ -f "backend/pyproject.toml" ] && [ -d "frontend" ]; then
  REPO_ROOT="$(pwd)"
  say "Using existing checkout at $REPO_ROOT"
else
  if [ -d "$TARGET_DIR/.git" ]; then
    say "Updating existing checkout at $TARGET_DIR"
    git -C "$TARGET_DIR" pull --ff-only origin "$BRANCH" || true
  else
    say "Cloning ScAI-Reader into $TARGET_DIR"
    git clone --branch "$BRANCH" "$REPO_URL" "$TARGET_DIR"
  fi
  REPO_ROOT="$TARGET_DIR"
fi

# --- Install + build --------------------------------------------------------
cd "$REPO_ROOT"
./scripts/setup.sh

say "Installed."
echo "To start ScAI-Reader:"
echo
echo "    cd \"$REPO_ROOT\""
echo "    ./scripts/run.sh"
echo
echo "Then open http://localhost:8000 (it opens automatically). AI explanations"
echo "are set up inside the app — no command-line key needed."
