"""Link-annotation extraction (pdfium-specific).

Citation markers in well-produced PDFs are clickable links that jump to the
reference entry. Those links are the highest-precision signal we have for
"this is a citation, and here is exactly where it points" — far better than
guessing from font size. This module pulls them out via pdfium's raw link API.

Everything here is pdfium-specific (raw ctypes bindings), so it lives apart
from the pure text-heuristic modules (``figures.py``, ``citations.py``). The
locked entry point is ``PdfiumBackend.get_links``; this module holds the raw
enumeration so that code is isolated and independently testable.

Coordinates come out of pdfium in PDF points with a bottom-left origin; we flip
them to the top-left origin the rest of the app uses (same convention as
``get_page_text``).
"""

from __future__ import annotations

import ctypes

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

from .types import BBox, LinkAnnotation


def _link_uri(raw_doc, link) -> str | None:
    """Return the external URL of a link's action, or None if it isn't a URI."""
    action = pdfium_c.FPDFLink_GetAction(link)
    if not action:
        return None
    if pdfium_c.FPDFAction_GetType(action) != pdfium_c.PDFACTION_URI:
        return None
    # Two-call pattern: first query the length (incl. NUL), then fill a buffer.
    length = pdfium_c.FPDFAction_GetURIPath(raw_doc, action, None, 0)
    if length <= 0:
        return None
    buf = ctypes.create_string_buffer(length)
    pdfium_c.FPDFAction_GetURIPath(raw_doc, action, buf, length)
    uri = buf.raw[:length].split(b"\x00", 1)[0].decode("utf-8", "replace")
    return uri or None


def _dest_page_index(raw_doc, link) -> int | None:
    """Resolve a link's internal destination to a 0-indexed page, or None.

    Handles both a direct destination and one reached via a GoTo action."""
    dest = pdfium_c.FPDFLink_GetDest(raw_doc, link)
    if not dest:
        action = pdfium_c.FPDFLink_GetAction(link)
        if action and pdfium_c.FPDFAction_GetType(action) in (
            pdfium_c.PDFACTION_GOTO,
            pdfium_c.PDFACTION_UNSUPPORTED,
        ):
            dest = pdfium_c.FPDFAction_GetDest(raw_doc, action)
    if not dest:
        return None
    idx = pdfium_c.FPDFDest_GetDestPageIndex(raw_doc, dest)
    return int(idx) if idx is not None and idx >= 0 else None


def extract_page_links(
    page: pdfium.PdfPage,
    doc: pdfium.PdfDocument,
    page_height_pt: float,
) -> list[LinkAnnotation]:
    """Enumerate every link annotation on ``page``.

    Caller must hold the pdfium lock (this touches raw handles). Rects are
    converted to top-left page-space points. Zero-area links are skipped.
    """
    raw_page = page.raw
    raw_doc = doc.raw
    out: list[LinkAnnotation] = []

    start = ctypes.c_int(0)
    link = pdfium_c.FPDF_LINK()
    while pdfium_c.FPDFLink_Enumerate(
        raw_page, ctypes.byref(start), ctypes.byref(link)
    ):
        rect = pdfium_c.FS_RECTF()
        if not pdfium_c.FPDFLink_GetAnnotRect(link, ctypes.byref(rect)):
            continue
        x0 = min(rect.left, rect.right)
        x1 = max(rect.left, rect.right)
        # PDF y grows up; the visual top is the larger y. Flip to top-left.
        top_pdf = max(rect.top, rect.bottom)
        bot_pdf = min(rect.top, rect.bottom)
        bbox = BBox(
            x0=float(x0),
            y0=float(page_height_pt - top_pdf),
            x1=float(x1),
            y1=float(page_height_pt - bot_pdf),
        )
        if bbox.width <= 0 or bbox.height <= 0:
            continue
        out.append(
            LinkAnnotation(
                bbox=bbox,
                dest_page_index=_dest_page_index(raw_doc, link),
                uri=_link_uri(raw_doc, link),
            )
        )
    return out
