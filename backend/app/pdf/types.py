from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


@dataclass(frozen=True)
class BBox:
    """Axis-aligned bounding box in PDF page coordinates (points, origin top-left).

    Page coordinates use the same convention as image output: (0, 0) is the
    top-left corner, x grows right, y grows down. This differs from raw PDF
    coordinates (origin bottom-left) — backends are responsible for converting.
    """

    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.y1 - self.y0

    def contains_point(self, x: float, y: float) -> bool:
        return self.x0 <= x <= self.x1 and self.y0 <= y <= self.y1


@dataclass(frozen=True)
class TextRun:
    text: str
    bbox: BBox
    font_size: float


@dataclass(frozen=True)
class TextColumn:
    """A contiguous vertical region of text. Runs are in visual reading order."""

    bbox: BBox
    runs: tuple[TextRun, ...]


@dataclass(frozen=True)
class PageText:
    page_index: int
    runs: tuple[TextRun, ...]
    columns: tuple[TextColumn, ...] = field(default_factory=tuple)

    @property
    def plain(self) -> str:
        return "".join(r.text for r in self.runs)


@dataclass(frozen=True)
class PageDimensions:
    width_pt: float
    height_pt: float


@dataclass(frozen=True)
class OutlineNode:
    title: str
    page_index: int | None
    children: tuple["OutlineNode", ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class DocumentMetadata:
    page_count: int
    title: str | None = None
    author: str | None = None


PixelFormat = Literal["RGB", "RGBA"]
