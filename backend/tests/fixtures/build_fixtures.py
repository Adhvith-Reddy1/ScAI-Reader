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


def build_all(into: Path = FIXTURES_DIR) -> dict[str, Path]:
    into.mkdir(parents=True, exist_ok=True)
    built: dict[str, Path] = {}
    spec = {
        "simple_two_page.pdf": build_simple_two_page,
        "outline_doc.pdf": build_outline_doc,
        "two_column.pdf": build_two_column,
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
