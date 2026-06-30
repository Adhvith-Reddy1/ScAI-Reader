from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import load_dotenv
from .routes import (
    annotations,
    documents,
    explanations,
    figures,
    outline,
    pages,
    search,
    settings as settings_routes,
    stateless_ai,
    text,
)
from .routes.deps import get_settings
from .storage import db

# Load .env (if present) before settings/clients read os.environ.
load_dotenv()


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    settings.ensure_dirs()
    db.init_db(settings.db_path)
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="ScAI-Reader", version="0.1.0", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(documents.router)
    app.include_router(pages.router)
    app.include_router(text.router)
    app.include_router(annotations.router)
    app.include_router(explanations.router)
    app.include_router(figures.router)
    app.include_router(stateless_ai.router)
    app.include_router(outline.router)
    app.include_router(search.router)
    app.include_router(settings_routes.router)

    @app.get("/healthz")
    def health() -> dict:
        return {"ok": True}

    # Serve built frontend if present (production single-binary mode)
    static_root = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
    if static_root.exists():
        app.mount("/", StaticFiles(directory=static_root, html=True), name="frontend")

    return app


app = create_app()
