from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def load_dotenv(path: Path | None = None) -> None:
    """Load KEY=VALUE pairs from a .env file into os.environ.

    Dependency-free and intentionally minimal: skips blank lines and
    ``#`` comments, strips an optional ``export`` prefix, and trims one
    layer of surrounding single/double quotes. Existing environment
    variables always win, so an exported key is never clobbered.

    Looks for ``.env`` at the repository root (two levels above this
    file) when no explicit path is given. Missing file is a no-op.
    """
    if path is None:
        path = Path(__file__).resolve().parent.parent.parent / ".env"
    if not path.is_file():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        key, sep, value = line.partition("=")
        if not sep:
            continue
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    db_path: Path
    pdf_dir: Path
    render_cache_dir: Path
    default_dpi: int = 150
    max_dpi: int = 600
    upload_max_bytes: int = 200 * 1024 * 1024

    @classmethod
    def from_env(cls) -> "Settings":
        data_dir = Path(os.environ.get("PDF_READER_DATA_DIR", "data")).resolve()
        return cls(
            data_dir=data_dir,
            db_path=data_dir / "reader.db",
            pdf_dir=data_dir / "pdfs",
            render_cache_dir=data_dir / "renders",
        )

    def ensure_dirs(self) -> None:
        self.pdf_dir.mkdir(parents=True, exist_ok=True)
        self.render_cache_dir.mkdir(parents=True, exist_ok=True)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
