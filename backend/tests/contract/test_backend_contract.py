"""The keystone test suite.

Every concrete :class:`PdfBackend` implementation must pass this suite. As you
write replacement backends (tokenizer-based, custom renderer, etc.) you add them
to ``BACKENDS`` and the same assertions run unchanged. A behavior that is not
checked here is not guaranteed.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

import pytest

from app.pdf.backend import PdfBackend, PdfError
from app.pdf.pdfium_backend import PdfiumBackend
from app.pdf.types import OutlineNode

# (id, opener) — opener takes a path, returns a PdfBackend.
BACKENDS: list[tuple[str, Callable[[Path], PdfBackend]]] = [
    ("pdfium", PdfiumBackend.open),
]


@pytest.fixture(params=BACKENDS, ids=[b[0] for b in BACKENDS])
def backend_opener(request) -> Callable[[Path], PdfBackend]:
    return request.param[1]


# ---------------------------------------------------------------------------
# Basic contract
# ---------------------------------------------------------------------------

def test_page_count_matches(backend_opener, simple_pdf):
    with backend_opener(simple_pdf) as b:
        assert b.page_count() == 2


def test_metadata_round_trips_title(backend_opener, simple_pdf):
    with backend_opener(simple_pdf) as b:
        meta = b.metadata()
        assert meta.page_count == 2
        assert meta.title == "Simple Two Page"


def test_page_dimensions_letter(backend_opener, simple_pdf):
    with backend_opener(simple_pdf) as b:
        dims = b.page_dimensions(0)
        assert dims.width_pt == pytest.approx(612.0, abs=0.5)
        assert dims.height_pt == pytest.approx(792.0, abs=0.5)


@pytest.mark.parametrize("bad_index", [-1, 99])
def test_invalid_page_raises(backend_opener, simple_pdf, bad_index):
    with backend_opener(simple_pdf) as b:
        with pytest.raises(PdfError):
            b.render_page(bad_index, dpi=72)


def test_invalid_dpi_raises(backend_opener, simple_pdf):
    with backend_opener(simple_pdf) as b:
        with pytest.raises(PdfError):
            b.render_page(0, dpi=0)


def test_open_missing_file_raises(backend_opener, tmp_path):
    with pytest.raises(PdfError):
        backend_opener(tmp_path / "nonexistent.pdf")


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def test_render_returns_png(backend_opener, simple_pdf):
    with backend_opener(simple_pdf) as b:
        png = b.render_page(0, dpi=72)
    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    assert len(png) > 200


def test_render_higher_dpi_yields_more_bytes(backend_opener, simple_pdf):
    with backend_opener(simple_pdf) as b:
        small = b.render_page(0, dpi=72)
        large = b.render_page(0, dpi=200)
    assert len(large) > len(small)


# ---------------------------------------------------------------------------
# Text extraction
# ---------------------------------------------------------------------------

def test_text_extraction_finds_expected_strings(backend_opener, simple_pdf):
    with backend_opener(simple_pdf) as b:
        page = b.get_page_text(0)
    plain = page.plain
    assert "Custom PDF Reader" in plain
    assert "quick brown fox" in plain


def test_two_column_pdf_extracts_two_columns(backend_opener, two_column_pdf):
    with backend_opener(two_column_pdf) as b:
        page = b.get_page_text(0)
    assert len(page.columns) == 2, (
        f"expected 2 columns, got {len(page.columns)}; "
        f"columns: {[(c.bbox.x0, c.bbox.x1) for c in page.columns]}"
    )
    left_plain = "".join(r.text for r in page.columns[0].runs)
    right_plain = "".join(r.text for r in page.columns[1].runs)
    assert "Left column" in left_plain
    assert "Right column" in right_plain
    assert "Right column" not in left_plain
    assert "Left column" not in right_plain


def test_single_column_pdf_extracts_one_column(backend_opener, simple_pdf):
    with backend_opener(simple_pdf) as b:
        page = b.get_page_text(0)
    assert len(page.columns) == 1


def test_columns_contain_every_run(backend_opener, two_column_pdf):
    with backend_opener(two_column_pdf) as b:
        page = b.get_page_text(0)
    assigned = sum(len(c.runs) for c in page.columns)
    assert assigned == len(page.runs)


def test_text_runs_have_valid_bboxes(backend_opener, simple_pdf):
    with backend_opener(simple_pdf) as b:
        dims = b.page_dimensions(0)
        page = b.get_page_text(0)
    assert page.runs
    for run in page.runs:
        assert run.bbox.x0 >= 0
        assert run.bbox.y0 >= 0
        assert run.bbox.x1 <= dims.width_pt + 1
        assert run.bbox.y1 <= dims.height_pt + 1
        assert run.bbox.width > 0
        assert run.bbox.height > 0


# ---------------------------------------------------------------------------
# Outline
# ---------------------------------------------------------------------------

def test_outline_tree_shape(backend_opener, outline_pdf):
    with backend_opener(outline_pdf) as b:
        outline = b.get_outline()

    assert len(outline) == 2
    chapter_titles = [n.title for n in outline]
    assert chapter_titles == ["Chapter 1", "Chapter 2"]

    assert len(outline[0].children) == 1
    assert outline[0].children[0].title == "1.1 Intro"
    assert len(outline[1].children) == 1
    assert outline[1].children[0].title == "2.1 Methods"


def test_outline_empty_for_doc_without_bookmarks(backend_opener, simple_pdf):
    with backend_opener(simple_pdf) as b:
        outline = b.get_outline()
    assert outline == ()


def _flatten(nodes: tuple[OutlineNode, ...]) -> list[OutlineNode]:
    out: list[OutlineNode] = []
    for n in nodes:
        out.append(n)
        out.extend(_flatten(n.children))
    return out


def test_outline_page_indices_within_range(backend_opener, outline_pdf):
    with backend_opener(outline_pdf) as b:
        outline = b.get_outline()
        n_pages = b.page_count()
    for node in _flatten(outline):
        if node.page_index is not None:
            assert 0 <= node.page_index < n_pages
