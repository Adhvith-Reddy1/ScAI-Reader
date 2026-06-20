from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


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
