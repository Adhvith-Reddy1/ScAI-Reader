from __future__ import annotations

from app.config import Settings
from app.storage import files


def _settings(tmp_path):
    s = Settings(
        data_dir=tmp_path,
        db_path=tmp_path / "db.sqlite",
        pdf_dir=tmp_path / "pdfs",
        render_cache_dir=tmp_path / "renders",
    )
    s.ensure_dirs()
    return s


def test_sha256_keying_is_stable(tmp_path):
    s = _settings(tmp_path)
    id_a = files.save_pdf(s, b"hello")
    id_b = files.save_pdf(s, b"hello")
    id_c = files.save_pdf(s, b"world")
    assert id_a == id_b
    assert id_a != id_c


def test_save_pdf_writes_to_keyed_path(tmp_path):
    s = _settings(tmp_path)
    doc_id = files.save_pdf(s, b"content")
    assert files.pdf_path(s, doc_id).read_bytes() == b"content"


def test_render_path_includes_dpi(tmp_path):
    s = _settings(tmp_path)
    p1 = files.render_path(s, "abc", 0, 72)
    p2 = files.render_path(s, "abc", 0, 150)
    assert p1 != p2


def test_write_render_cache_persists(tmp_path):
    s = _settings(tmp_path)
    path = files.write_render_cache(s, "abc", 3, 100, b"\x89PNG")
    assert path.read_bytes() == b"\x89PNG"
