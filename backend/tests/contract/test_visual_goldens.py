"""Visual golden tests — assert rendered PDF pages match committed baselines.

First run: ``pytest --update-goldens`` creates the goldens (skips assertions).
Subsequent runs: compares actual render bytes against the stored golden via
SHA-256 → pixel-perfect → SSIM ladder defined in conftest.
"""

from __future__ import annotations

import pytest

from app.pdf.pdfium_backend import PdfiumBackend


@pytest.mark.visual
@pytest.mark.parametrize("page_index", [0, 1])
@pytest.mark.parametrize("dpi", [72, 150])
def test_simple_pdf_render_matches_golden(simple_pdf, assert_golden, page_index, dpi):
    with PdfiumBackend.open(simple_pdf) as b:
        png = b.render_page(page_index, dpi=dpi)
    assert_golden(f"simple_two_page/page{page_index}_dpi{dpi}", png)


@pytest.mark.visual
@pytest.mark.parametrize("page_index", [0, 1, 2, 3])
def test_outline_pdf_render_matches_golden(outline_pdf, assert_golden, page_index):
    with PdfiumBackend.open(outline_pdf) as b:
        png = b.render_page(page_index, dpi=100)
    assert_golden(f"outline_doc/page{page_index}_dpi100", png)
