# Single-image build for ScAI-Reader. One stateless container serves both the
# API and the built SPA on $PORT (default 8080). Personal data lives in the
# user's browser (see docs/specs/README.md), so the container keeps no durable
# state and needs no volume.

# --- Stage 1: build the frontend (Vite) -> frontend/dist --------------------
FROM node:22-slim AS frontend
# The frontend devDeps include @playwright/test (E2E only). Stop its install
# hook from downloading browsers during the build — the build doesn't need them.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app/frontend
# Install deps first for layer caching; lockfile drives a reproducible install.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# --- Stage 2: python runtime ------------------------------------------------
FROM python:3.12-slim AS runtime
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080

WORKDIR /app
# Backend source. Installed editable so app/main.py's path to the SPA
# (parents[2] of the module == /app) resolves to /app/frontend/dist below.
COPY backend/ /app/backend/
RUN pip install -e /app/backend

# Built SPA where app.main mounts it: <repo>/frontend/dist.
COPY --from=frontend /app/frontend/dist /app/frontend/dist

# Run from the backend dir so the (ephemeral) data dir is /app/backend/data.
WORKDIR /app/backend
EXPOSE 8080

# Shell form honours an injected $PORT; defaults to 8080.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
