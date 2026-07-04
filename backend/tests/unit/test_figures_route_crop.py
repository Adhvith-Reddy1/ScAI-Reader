"""Tests for `crop_to_bbox` — the AI-explain vision payload cropper.

A double-click on one panel of a multi-panel figure should send the model a
tight crop of just that panel, not the whole page: the whole point of
sub-panel detection is a more relevant explanation, and a full-page image
defeats that (see app.pdf.figures module docstring)."""

from __future__ import annotations

import io

import pytest
from PIL import Image

from app.routes.figures import BBoxModel, crop_to_bbox

PAGE_WIDTH_PT = 612.0
PAGE_HEIGHT_PT = 792.0
DPI = 150


def _render_page_png(width_px: int, height_px: int, fmt: str = "PNG") -> bytes:
    image = Image.new("RGB", (width_px, height_px), color=(255, 255, 255))
    buf = io.BytesIO()
    image.save(buf, format=fmt)
    return buf.getvalue()


def _page_png() -> bytes:
    scale = DPI / 72.0
    return _render_page_png(round(PAGE_WIDTH_PT * scale), round(PAGE_HEIGHT_PT * scale))


def test_crop_shrinks_the_image():
    page_png = _page_png()
    bbox = BBoxModel(x0=100, y0=100, x1=200, y1=150)

    cropped = crop_to_bbox(page_png, bbox, PAGE_WIDTH_PT, PAGE_HEIGHT_PT, DPI)

    full = Image.open(io.BytesIO(page_png))
    small = Image.open(io.BytesIO(cropped))
    assert small.width < full.width
    assert small.height < full.height


def test_crop_dimensions_match_bbox_plus_padding():
    page_png = _page_png()
    bbox = BBoxModel(x0=100, y0=100, x1=200, y1=150)
    pad = 20.0
    scale = DPI / 72.0

    cropped = crop_to_bbox(page_png, bbox, PAGE_WIDTH_PT, PAGE_HEIGHT_PT, DPI)

    small = Image.open(io.BytesIO(cropped))
    expected_w = round((bbox.x1 - bbox.x0 + 2 * pad) * scale)
    expected_h = round((bbox.y1 - bbox.y0 + 2 * pad) * scale)
    assert small.width == pytest.approx(expected_w, abs=2)
    assert small.height == pytest.approx(expected_h, abs=2)


def test_crop_clamps_to_page_bounds_near_edges():
    """A panel near the page edge shouldn't ask PIL to crop outside the
    image — the padding alone would otherwise push the box off-page."""
    page_png = _page_png()
    bbox = BBoxModel(x0=0, y0=0, x1=50, y1=50)

    cropped = crop_to_bbox(page_png, bbox, PAGE_WIDTH_PT, PAGE_HEIGHT_PT, DPI)

    small = Image.open(io.BytesIO(cropped))
    assert small.width > 0
    assert small.height > 0


def test_crop_preserves_jpeg_format():
    page_png = _render_page_png(
        round(PAGE_WIDTH_PT * DPI / 72), round(PAGE_HEIGHT_PT * DPI / 72), fmt="JPEG"
    )
    bbox = BBoxModel(x0=100, y0=100, x1=200, y1=150)

    cropped = crop_to_bbox(page_png, bbox, PAGE_WIDTH_PT, PAGE_HEIGHT_PT, DPI)

    assert cropped.startswith(b"\xff\xd8\xff")


def test_crop_preserves_png_format():
    page_png = _page_png()
    bbox = BBoxModel(x0=100, y0=100, x1=200, y1=150)

    cropped = crop_to_bbox(page_png, bbox, PAGE_WIDTH_PT, PAGE_HEIGHT_PT, DPI)

    assert cropped.startswith(b"\x89PNG\r\n\x1a\n")


def test_crop_falls_back_to_original_on_degenerate_bbox():
    """A bbox entirely off-page (e.g. stale coordinates from a resized/
    re-rendered page) clamps to nothing usable — return the original image
    rather than asking PIL to crop an inverted/empty box."""
    page_png = _page_png()
    bbox = BBoxModel(x0=700, y0=700, x1=750, y1=750)

    cropped = crop_to_bbox(page_png, bbox, PAGE_WIDTH_PT, PAGE_HEIGHT_PT, DPI)

    assert cropped == page_png
