from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path
from typing import Iterator

import pytest
from PIL import Image, ImageChops

try:
    from skimage.metrics import structural_similarity as ssim
    import numpy as np

    _HAS_SSIM = True
except ImportError:  # pragma: no cover
    _HAS_SSIM = False

from tests.fixtures.build_fixtures import build_all


# ---------------------------------------------------------------------------
# CLI options
# ---------------------------------------------------------------------------

def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--update-goldens",
        action="store_true",
        default=False,
        help="Write/refresh golden images instead of asserting against them. "
        "Each run becomes a recorded snapshot; commit the resulting files.",
    )


# ---------------------------------------------------------------------------
# Fixture PDFs (deterministic; built lazily, cached on disk)
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def fixture_pdfs() -> dict[str, Path]:
    return build_all()


@pytest.fixture(scope="session")
def simple_pdf(fixture_pdfs: dict[str, Path]) -> Path:
    return fixture_pdfs["simple_two_page.pdf"]


@pytest.fixture(scope="session")
def outline_pdf(fixture_pdfs: dict[str, Path]) -> Path:
    return fixture_pdfs["outline_doc.pdf"]


@pytest.fixture(scope="session")
def two_column_pdf(fixture_pdfs: dict[str, Path]) -> Path:
    return fixture_pdfs["two_column.pdf"]


# ---------------------------------------------------------------------------
# Isolated app settings per integration test
# ---------------------------------------------------------------------------

@pytest.fixture
def tmp_settings(tmp_path: Path):
    from app.config import Settings

    data_dir = tmp_path / "data"
    settings = Settings(
        data_dir=data_dir,
        db_path=data_dir / "reader.db",
        pdf_dir=data_dir / "pdfs",
        render_cache_dir=data_dir / "renders",
    )
    settings.ensure_dirs()
    return settings


@pytest.fixture
def app_client(tmp_settings):
    """FastAPI TestClient wired to an isolated data dir, with DB initialised."""
    from fastapi.testclient import TestClient
    from app.main import create_app
    from app.routes.deps import get_settings
    from app.storage import db

    db.init_db(tmp_settings.db_path)

    app = create_app()
    app.dependency_overrides[get_settings] = lambda: tmp_settings
    with TestClient(app) as client:
        yield client


# ---------------------------------------------------------------------------
# Visual golden comparison
# ---------------------------------------------------------------------------

GOLDENS_ROOT = Path(__file__).resolve().parent / "goldens"
FAILURES_ROOT = Path(__file__).resolve().parent / "_failures"

SSIM_THRESHOLD = 0.995
PIXEL_TOLERANCE = 2  # max per-channel diff for "pixel-perfect"


class GoldenMismatch(AssertionError):
    pass


def _save_diff_artifact(name: str, actual: bytes, golden_bytes: bytes | None) -> Path:
    """Persist the failing render + diff alongside the test output for inspection."""
    FAILURES_ROOT.mkdir(parents=True, exist_ok=True)
    actual_path = FAILURES_ROOT / f"{name}__actual.png"
    actual_path.write_bytes(actual)
    if golden_bytes is not None:
        (FAILURES_ROOT / f"{name}__golden.png").write_bytes(golden_bytes)
        a = Image.open(actual_path).convert("RGB")
        g = Image.open(FAILURES_ROOT / f"{name}__golden.png").convert("RGB")
        if a.size == g.size:
            ImageChops.difference(a, g).save(FAILURES_ROOT / f"{name}__diff.png")
    return actual_path


def _compare_images(actual: bytes, golden: bytes) -> tuple[bool, str]:
    """Run the strictness ladder. Returns (passed, reason)."""
    if hashlib.sha256(actual).digest() == hashlib.sha256(golden).digest():
        return True, "sha256-equal"

    a = Image.open(__import__("io").BytesIO(actual)).convert("RGB")
    g = Image.open(__import__("io").BytesIO(golden)).convert("RGB")

    if a.size != g.size:
        return False, f"size differs: actual={a.size} golden={g.size}"

    diff = ImageChops.difference(a, g)
    bbox = diff.getbbox()
    if bbox is None:
        return True, "decoded-identical"

    max_channel = max(diff.getextrema(), key=lambda t: t[1])[1]
    if max_channel <= PIXEL_TOLERANCE:
        return True, f"pixel-perfect (max diff {max_channel})"

    if _HAS_SSIM:
        score = ssim(np.asarray(a), np.asarray(g), channel_axis=2)
        if score >= SSIM_THRESHOLD:
            return True, f"ssim {score:.4f} (>= {SSIM_THRESHOLD})"
        return False, f"ssim {score:.4f} (< {SSIM_THRESHOLD})"

    return False, f"max channel diff {max_channel} > {PIXEL_TOLERANCE}"


@pytest.fixture
def assert_golden(request: pytest.FixtureRequest):
    update = request.config.getoption("--update-goldens")

    def _check(name: str, actual_png: bytes) -> None:
        golden_path = GOLDENS_ROOT / f"{name}.png"

        if update or not golden_path.exists():
            golden_path.parent.mkdir(parents=True, exist_ok=True)
            golden_path.write_bytes(actual_png)
            if update:
                pytest.skip(
                    f"updated golden {golden_path.relative_to(GOLDENS_ROOT.parent)}"
                )
            return

        golden_bytes = golden_path.read_bytes()
        passed, reason = _compare_images(actual_png, golden_bytes)
        if not passed:
            artifact = _save_diff_artifact(name.replace("/", "__"), actual_png, golden_bytes)
            raise GoldenMismatch(
                f"golden mismatch for {name}: {reason}\n"
                f"  golden : {golden_path}\n"
                f"  actual : {artifact}\n"
                f"  diff   : {artifact.with_name(artifact.stem.replace('__actual', '__diff')+'.png')}"
            )

    return _check
