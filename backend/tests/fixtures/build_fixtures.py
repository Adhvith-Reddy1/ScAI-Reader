"""Deterministic fixture-PDF builder.

The goal is byte-stable PDFs so visual goldens stay reproducible across
machines. reportlab is *not* fully byte-stable by default (XMP timestamps,
producer string), but the rendered page output IS deterministic across runs
with the same reportlab version — which is what the visual ladder asserts.

Run directly to regenerate fixtures::

    python -m tests.fixtures.build_fixtures
"""

from __future__ import annotations

from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

FIXTURES_DIR = Path(__file__).resolve().parent / "pdfs"


def build_simple_two_page(path: Path) -> None:
    """A born-digital, single-column PDF — covers the happy path."""
    c = canvas.Canvas(str(path), pagesize=letter)

    c.setTitle("Simple Two Page")
    c.setAuthor("PDF Reader Test Suite")

    c.setFont("Helvetica-Bold", 24)
    c.drawString(72, 720, "Custom PDF Reader")
    c.setFont("Helvetica", 12)
    c.drawString(72, 690, "This is page one of a deterministic test fixture.")
    c.drawString(72, 672, "Line two with some more text to extract.")
    c.drawString(72, 654, "The quick brown fox jumps over the lazy dog.")
    c.showPage()

    c.setFont("Helvetica-Bold", 18)
    c.drawString(72, 720, "Page Two")
    c.setFont("Helvetica", 12)
    c.drawString(72, 690, "Second page content for multi-page navigation tests.")
    c.showPage()

    c.save()


def build_outline_doc(path: Path) -> None:
    """A 4-page document with a 2-level outline tree, for outline tests."""
    c = canvas.Canvas(str(path), pagesize=letter)
    c.setTitle("Outline Doc")

    for i, label in enumerate(["Chapter 1", "  1.1 Intro", "Chapter 2", "  2.1 Methods"]):
        c.setFont("Helvetica", 16)
        c.drawString(72, 720, label.strip())
        c.bookmarkPage(f"p{i}")
        c.showPage()

    # bookmark tree: Chapter 1 -> 1.1 ; Chapter 2 -> 2.1
    c.addOutlineEntry("Chapter 1", "p0", level=0)
    c.addOutlineEntry("1.1 Intro", "p1", level=1)
    c.addOutlineEntry("Chapter 2", "p2", level=0)
    c.addOutlineEntry("2.1 Methods", "p3", level=1)
    c.showOutline()

    c.save()


def build_two_column(path: Path) -> None:
    """A 2-column layout — exercises column-bleed defenses."""
    c = canvas.Canvas(str(path), pagesize=letter)
    c.setTitle("Two Column")
    c.setFont("Helvetica", 11)

    left_x, right_x = 72, 320
    for i, line in enumerate(
        [
            "Left column paragraph line one.",
            "Left column paragraph line two.",
            "Left column paragraph line three.",
            "Left column paragraph line four.",
        ]
    ):
        c.drawString(left_x, 700 - i * 16, line)

    for i, line in enumerate(
        [
            "Right column paragraph line one.",
            "Right column paragraph line two.",
            "Right column paragraph line three.",
            "Right column paragraph line four.",
        ]
    ):
        c.drawString(right_x, 700 - i * 16, line)

    c.showPage()
    c.save()


def _draw_placeholder_chart(c: canvas.Canvas, x0: float, y0: float, x1: float, y1: float) -> None:
    """A simple bar-chart-looking rectangle standing in for a real figure
    image — real PDFs have a raster/vector figure here, not whitespace. This
    is irrelevant to `detect_figures` (which only reasons about the text
    gap), but it makes screenshots of the FigureLayer outline meaningful: a
    human can see whether the box actually lands on "the figure"."""
    c.saveState()
    c.setStrokeColorRGB(0.4, 0.4, 0.4)
    c.rect(x0, y0, x1 - x0, y1 - y0, stroke=1, fill=0)
    bar_w = (x1 - x0) / 6
    for i, h_frac in enumerate([0.3, 0.55, 0.4, 0.8, 0.6]):
        bx = x0 + bar_w * (i + 0.5)
        c.setFillColorRGB(0.6, 0.6, 0.6)
        c.rect(bx, y0 + 4, bar_w * 0.6, (y1 - y0 - 8) * h_frac, stroke=0, fill=1)
    c.restoreState()


def build_figure_doc(path: Path) -> None:
    """A 2-page fixture mimicking a real academic paper: single-column body
    text with a captioned figure (page 1), and a genuine 2-column layout with
    a captioned figure confined to one column (page 2). Exercises the FULL
    real pipeline — PDFium text extraction, column clustering, and
    detect_figures together — which the synthetic-PageText unit tests in
    test_figures.py cannot, since those build TextRun/TextColumn by hand."""
    c = canvas.Canvas(str(path), pagesize=letter)
    c.setTitle("Figure Doc")

    # --- Page 1: single column, one figure -------------------------------
    c.setFont("Helvetica-Bold", 14)
    c.drawString(72, 740, "3. Results")
    c.setFont("Helvetica", 11)
    for i, line in enumerate(
        [
            "We evaluated the pipeline across three independent runs.",
            "Each run used the same held-out validation split.",
            "The overall trend is summarized in the figure below.",
        ]
    ):
        c.drawString(72, 712 - i * 16, line)

    _draw_placeholder_chart(c, 130, 560, 480, 650)
    c.setFont("Helvetica", 10)
    c.drawString(72, 540, "Figure 1: Overview of the experimental pipeline across three stages.")

    c.setFont("Helvetica", 11)
    for i, line in enumerate(
        [
            "As shown above, performance improves with each stage.",
            "The remainder of this section discusses stage three.",
        ]
    ):
        c.drawString(72, 510 - i * 16, line)
    c.showPage()

    # --- Page 2: two columns, figure confined to the left column ---------
    # Reuses build_two_column's exact wording for the 4+4 filler lines: the
    # column clusterer buckets by measured glyph-bbox height as a font-size
    # proxy (see PdfiumBackend.get_page_text), which is noisy per-string —
    # novel sentences here previously pushed a line's measured size just far
    # enough from the body-font mode to drop a column under the minimum-run
    # threshold and collapse detection to one column. Known-good wording
    # avoids re-triggering that.
    c.setFont("Helvetica", 11)
    left_x, right_x = 72, 320
    for i, line in enumerate(
        [
            "Left column paragraph line one.",
            "Left column paragraph line two.",
        ]
    ):
        c.drawString(left_x, 700 - i * 16, line)

    _draw_placeholder_chart(c, left_x, 560, 270, 640)
    c.setFont("Helvetica", 9)
    c.drawString(left_x, 540, "Figure 2: Detailed close-up of region A.")
    c.setFont("Helvetica", 11)
    for i, line in enumerate(
        [
            "Left column paragraph line three.",
            "Left column paragraph line four.",
        ]
    ):
        c.drawString(left_x, 520 - i * 16, line)

    for i, line in enumerate(
        [
            "Right column paragraph line one.",
            "Right column paragraph line two.",
            "Right column paragraph line three.",
            "Right column paragraph line four.",
        ]
    ):
        c.drawString(right_x, 700 - i * 16, line)
    c.showPage()

    c.save()


def build_all(into: Path = FIXTURES_DIR) -> dict[str, Path]:
    into.mkdir(parents=True, exist_ok=True)
    built: dict[str, Path] = {}
    spec = {
        "simple_two_page.pdf": build_simple_two_page,
        "outline_doc.pdf": build_outline_doc,
        "two_column.pdf": build_two_column,
        "figure_doc.pdf": build_figure_doc,
    }
    for name, fn in spec.items():
        target = into / name
        if not target.exists():
            fn(target)
        built[name] = target
    return built


if __name__ == "__main__":
    for name, path in build_all().items():
        print(f"{name}: {path}")
