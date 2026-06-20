"""Pure-logic tests for column clustering. No PDF needed."""

from __future__ import annotations

from app.pdf.columns import cluster_into_columns
from app.pdf.types import BBox, TextRun


def _run(x0: float, y0: float, x1: float, y1: float, text: str = "x") -> TextRun:
    return TextRun(text=text, bbox=BBox(x0, y0, x1, y1), font_size=10.0)


def test_empty_runs_returns_empty():
    assert cluster_into_columns((), page_width_pt=612.0) == ()


def test_single_run_one_column():
    runs = (_run(100, 100, 200, 110),)
    columns = cluster_into_columns(runs, page_width_pt=612.0)
    assert len(columns) == 1
    assert columns[0].runs == runs


def test_two_column_with_clear_gutter():
    # Left column at x=72-260, right column at x=320-540, ~60pt gutter.
    runs = tuple(
        _run(72, 100 + i * 12, 260, 110 + i * 12, f"L{i}") for i in range(4)
    ) + tuple(
        _run(320, 100 + i * 12, 540, 110 + i * 12, f"R{i}") for i in range(4)
    )
    columns = cluster_into_columns(runs, page_width_pt=612.0)
    assert len(columns) == 2
    left_texts = [r.text for r in columns[0].runs]
    right_texts = [r.text for r in columns[1].runs]
    assert left_texts == ["L0", "L1", "L2", "L3"]
    assert right_texts == ["R0", "R1", "R2", "R3"]


def test_single_column_with_no_gutter_stays_single():
    # All runs span the full text area — no horizontal gutter.
    runs = tuple(_run(72, 100 + i * 12, 540, 110 + i * 12) for i in range(6))
    columns = cluster_into_columns(runs, page_width_pt=612.0)
    assert len(columns) == 1


def test_three_columns():
    a = tuple(_run(72, 100 + i * 12, 180, 110 + i * 12, f"A{i}") for i in range(3))
    b = tuple(_run(220, 100 + i * 12, 330, 110 + i * 12, f"B{i}") for i in range(3))
    c = tuple(_run(370, 100 + i * 12, 480, 110 + i * 12, f"C{i}") for i in range(3))
    columns = cluster_into_columns(a + b + c, page_width_pt=612.0)
    assert len(columns) == 3


def test_every_run_assigned_to_exactly_one_column():
    runs = tuple(_run(72, 100 + i * 12, 260, 110 + i * 12) for i in range(5)) + tuple(
        _run(320, 100 + i * 12, 540, 110 + i * 12) for i in range(5)
    )
    columns = cluster_into_columns(runs, page_width_pt=612.0)
    assigned = sum(len(c.runs) for c in columns)
    assert assigned == len(runs)


def test_runs_within_column_sorted_top_to_bottom():
    # Insert runs in shuffled order
    runs = (
        _run(72, 200, 260, 210, "L2"),
        _run(72, 100, 260, 110, "L0"),
        _run(72, 150, 260, 160, "L1"),
    )
    columns = cluster_into_columns(runs, page_width_pt=612.0)
    assert [r.text for r in columns[0].runs] == ["L0", "L1", "L2"]


def test_columns_too_close_fall_back_to_single():
    # Left starts at 72, right at 200 — only 128pt apart, below MIN_COLUMN_GAP_PT.
    runs = tuple(_run(72, 100 + i * 12, 180, 110 + i * 12, f"L{i}") for i in range(4)) + tuple(
        _run(200, 100 + i * 12, 290, 110 + i * 12, f"R{i}") for i in range(4)
    )
    columns = cluster_into_columns(runs, page_width_pt=612.0)
    assert len(columns) == 1


def test_falls_back_to_single_column_when_too_many_sparse_candidates():
    # Sparse, evenly spread runs — each bucket has < threshold; no column detected.
    runs = tuple(
        _run(72 + i * 40, 100, 72 + i * 40 + 18, 110, f"x{i}")
        for i in range(12)
    )
    columns = cluster_into_columns(runs, page_width_pt=612.0, max_columns=3)
    assert len(columns) == 1


def test_full_width_headers_do_not_break_column_detection():
    # Regression: the Virtual Lab paper failed because page titles, page
    # numbers, and headers (full-width runs) bridged the column gutter and
    # killed the coverage-profile heuristic. New algorithm should ignore them.
    # 50 body runs in each column + 3 "full-width" header runs.
    left = tuple(
        _run(72, 100 + i * 12, 280, 110 + i * 12, f"L{i}") for i in range(50)
    )
    right = tuple(
        _run(320, 100 + i * 12, 540, 110 + i * 12, f"R{i}") for i in range(50)
    )
    headers = tuple(
        _run(72, 50 + i * 14, 540, 60 + i * 14, f"H{i}") for i in range(3)
    )
    columns = cluster_into_columns(left + right + headers, page_width_pt=612.0)
    assert len(columns) == 2
