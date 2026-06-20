from __future__ import annotations

import io
import threading
from pathlib import Path

import pypdfium2 as pdfium

from .backend import PdfBackend, PdfError
from .columns import cluster_into_columns
from .types import (
    BBox,
    DocumentMetadata,
    OutlineNode,
    PageDimensions,
    PageText,
    TextRun,
)

# PDFium is not thread-safe. FastAPI dispatches sync route handlers to a
# threadpool, so concurrent page renders for the same document race inside
# libpdfium and segfault. We serialize every entry into PDFium via a single
# process-wide reentrant lock — coarse, but it kills the crash and stays
# correct. Future work (per-doc caching + parallel renders across documents)
# can use finer locking; the contract test suite locks the externally-visible
# behavior either way.
_PDFIUM_LOCK = threading.RLock()


class PdfiumBackend(PdfBackend):
    """PDF backend wrapping pypdfium2 (Apache 2.0, the PDFium engine).

    This is the v1 implementation. Future from-scratch implementations are
    expected to satisfy the same contract — see tests/contract/.
    """

    def __init__(self, doc: pdfium.PdfDocument) -> None:
        self._doc = doc

    @classmethod
    def open(cls, path: Path) -> "PdfiumBackend":
        with _PDFIUM_LOCK:
            try:
                doc = pdfium.PdfDocument(str(path))
            except (pdfium.PdfiumError, FileNotFoundError, OSError) as e:
                raise PdfError(f"failed to open {path}: {e}") from e
            return cls(doc)

    def close(self) -> None:
        with _PDFIUM_LOCK:
            self._doc.close()

    def metadata(self) -> DocumentMetadata:
        with _PDFIUM_LOCK:
            meta = self._doc.get_metadata_dict()
            return DocumentMetadata(
                page_count=len(self._doc),
                title=meta.get("Title") or None,
                author=meta.get("Author") or None,
            )

    def page_count(self) -> int:
        with _PDFIUM_LOCK:
            return len(self._doc)

    def _get_page(self, page_index: int) -> pdfium.PdfPage:
        if page_index < 0 or page_index >= len(self._doc):
            raise PdfError(
                f"page index {page_index} out of range (doc has {len(self._doc)} pages)"
            )
        return self._doc.get_page(page_index)

    def page_dimensions(self, page_index: int) -> PageDimensions:
        with _PDFIUM_LOCK:
            page = self._get_page(page_index)
            try:
                w, h = page.get_size()
                return PageDimensions(width_pt=float(w), height_pt=float(h))
            finally:
                page.close()

    def render_page(self, page_index: int, dpi: int) -> bytes:
        if dpi <= 0:
            raise PdfError(f"dpi must be positive, got {dpi}")
        with _PDFIUM_LOCK:
            page = self._get_page(page_index)
            try:
                scale = dpi / 72.0
                bitmap = page.render(scale=scale)
                pil_image = bitmap.to_pil()
                buf = io.BytesIO()
                pil_image.save(buf, format="PNG", optimize=False, compress_level=6)
                return buf.getvalue()
            finally:
                page.close()

    def get_page_text(self, page_index: int) -> PageText:
        with _PDFIUM_LOCK:
            page = self._get_page(page_index)
            try:
                page_width, page_height = page.get_size()
                textpage = page.get_textpage()
                try:
                    n_rects = textpage.count_rects()
                    runs: list[TextRun] = []
                    for i in range(n_rects):
                        left, bottom, right, top = textpage.get_rect(i)
                        text = textpage.get_text_bounded(left, bottom, right, top)
                        if not text.strip():
                            continue
                        bbox = BBox(
                            x0=float(left),
                            y0=float(page_height - top),
                            x1=float(right),
                            y1=float(page_height - bottom),
                        )
                        font_size = max(0.0, float(top - bottom))
                        runs.append(TextRun(text=text, bbox=bbox, font_size=font_size))
                    runs_t = tuple(runs)
                    columns = cluster_into_columns(runs_t, float(page_width))
                    return PageText(
                        page_index=page_index, runs=runs_t, columns=columns
                    )
                finally:
                    textpage.close()
            finally:
                page.close()

    def get_outline(self) -> tuple[OutlineNode, ...]:
        with _PDFIUM_LOCK:
            flat: list[tuple[int, str, int | None]] = []
            for bookmark in self._doc.get_toc():
                flat.append(
                    (
                        bookmark.level,
                        bookmark.get_title(),
                        self._resolve_dest_page(bookmark),
                    )
                )
            return _build_outline_tree(flat)

    @staticmethod
    def _resolve_dest_page(bookmark: pdfium.PdfBookmark) -> int | None:
        dest = bookmark.get_dest()
        if dest is None:
            return None
        try:
            idx = dest.get_index()
            return int(idx) if idx is not None and idx >= 0 else None
        except Exception:
            return None


def _build_outline_tree(
    flat: list[tuple[int, str, int | None]],
) -> tuple[OutlineNode, ...]:
    """Reconstruct a tree from pre-order DFS (level, title, page) records.

    pypdfium2's get_toc yields bookmarks in document order, each tagged with
    its depth. We walk the list once, using a stack of mutable children-lists,
    one per open ancestor.
    """
    roots: list[list] = []
    stack: list[tuple[int, list]] = [(-1, roots)]

    for level, title, page_index in flat:
        while stack and stack[-1][0] >= level:
            stack.pop()
        if not stack:
            stack.append((-1, roots))
        children: list = []
        stack[-1][1].append([title, page_index, children])
        stack.append((level, children))

    def freeze(items: list) -> tuple[OutlineNode, ...]:
        return tuple(
            OutlineNode(title=t, page_index=p, children=freeze(c))
            for t, p, c in items
        )

    return freeze(roots)
