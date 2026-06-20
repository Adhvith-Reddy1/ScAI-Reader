from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path

from .types import (
    DocumentMetadata,
    OutlineNode,
    PageDimensions,
    PageText,
)


class PdfError(Exception):
    """Raised on malformed PDFs, missing pages, or backend failures."""


class PdfBackend(ABC):
    """Abstract interface every PDF backend implements.

    The contract here is the spec future from-scratch implementations must
    satisfy. The single parametrized contract test suite in
    ``tests/contract/test_backend_contract.py`` runs against every concrete
    backend and is the source of truth for behavior.

    Backends are constructed from a file path. They may keep the underlying
    document open across calls; callers should ``close()`` when done.
    """

    @classmethod
    @abstractmethod
    def open(cls, path: Path) -> "PdfBackend":
        """Open a PDF file. Raises :class:`PdfError` on unreadable input."""

    @abstractmethod
    def close(self) -> None: ...

    @abstractmethod
    def metadata(self) -> DocumentMetadata: ...

    @abstractmethod
    def page_count(self) -> int: ...

    @abstractmethod
    def page_dimensions(self, page_index: int) -> PageDimensions:
        """Return page size in PDF points (1pt = 1/72 inch). Zero-indexed."""

    @abstractmethod
    def render_page(self, page_index: int, dpi: int) -> bytes:
        """Render a page to PNG bytes at the given DPI. Zero-indexed."""

    @abstractmethod
    def get_page_text(self, page_index: int) -> PageText:
        """Extract text runs with bounding boxes for one page."""

    @abstractmethod
    def get_outline(self) -> tuple[OutlineNode, ...]:
        """Document outline / bookmarks. Empty tuple if none."""

    def __enter__(self) -> "PdfBackend":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()
