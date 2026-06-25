# --- Stage 1: build the frontend into static assets ---
FROM node:22-slim AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# --- Stage 2: backend runtime serving the built SPA ---
FROM python:3.12-slim AS app
# Editable install keeps the package at /srv/scai/backend/app so main.py's
# relative lookup of ../../frontend/dist resolves correctly.
WORKDIR /srv/scai
COPY backend/ ./backend/
RUN pip install --no-cache-dir -e ./backend
COPY --from=frontend /build/dist ./frontend/dist

ENV PDF_READER_DATA_DIR=/data
EXPOSE 8000
WORKDIR /srv/scai/backend

# Single worker: PDFium is guarded by a global lock and SQLite is the store, so
# extra workers add contention without helping. Fine for demo-scale traffic.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
