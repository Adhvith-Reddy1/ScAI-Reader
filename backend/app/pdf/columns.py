"""Group text runs into reading-order columns.

Algorithm:

  1. Filter to "body text" runs by the page's dominant font size. Title,
     abstract, page numbers, headers, and footers all have different sizes
     than body text in academic papers, and they were the dominant source of
     misclassification before this filter existed (full-width abstract bridges
     the gutter; centered title forms a phantom mid-column peak).
  2. Histogram the body runs' ``x0`` (left edge) into ``BUCKET_SIZE``-point
     buckets.
  3. Keep buckets with at least ``max(3, sqrt(total_body))`` runs.
  4. For 3+ candidates with uneven gaps, drop to top 2 by count — handles
     within-column outliers (e.g. right-justified numbers).
  5. Reject if the smallest inter-peak gap < ``MIN_COLUMN_GAP_PT``.
  6. Boundaries at the *start* of the next peak's bucket. ALL runs (including
     the non-body runs we filtered out for detection) are assigned to columns
     by ``x0``. Title and footer runs end up in column 0 by virtue of starting
     near the left margin.
"""

from __future__ import annotations

from collections import Counter, defaultdict

from .types import BBox, TextColumn, TextRun

BUCKET_SIZE_PT = 30.0
MIN_COLUMN_GAP_PT = 140.0
UNIFORM_GAP_TOLERANCE = 0.15
DEFAULT_MAX_COLUMNS = 4
BODY_FONT_TOLERANCE_PCT = 0.15
"""Runs within ±15% of the page's body font size count as body text."""
MIN_BODY_RUN_RATIO = 0.15
"""If fewer than 15% of runs share the modal body font, skip filtering and use
all runs — the page probably has no dominant body font (e.g. a title slide)."""
MIN_BODY_FONT_PT = 6.0
"""Smaller than this is sub/superscript, inline math, or footnote markers —
not running prose. Excluded from mode detection so a page heavy in math
symbols doesn't pick 4.5pt over the actual 8pt body."""


def cluster_into_columns(
    runs: tuple[TextRun, ...],
    page_width_pt: float,
    max_columns: int = DEFAULT_MAX_COLUMNS,
) -> tuple[TextColumn, ...]:
    if not runs:
        return ()
    if len(runs) == 1:
        return (TextColumn(bbox=runs[0].bbox, runs=runs),)

    body_runs = _filter_to_body_text(runs)
    boundaries = _detect_column_boundaries(
        body_runs, page_width_pt, max_columns
    )
    if not boundaries:
        return _single_column(runs)

    buckets: list[list[TextRun]] = [[] for _ in range(len(boundaries) + 1)]
    for run in runs:
        idx = 0
        for b in boundaries:
            if run.bbox.x0 >= b:
                idx += 1
            else:
                break
        buckets[idx].append(run)

    columns: list[TextColumn] = []
    for bucket in buckets:
        if not bucket:
            continue
        bucket.sort(key=lambda r: (r.bbox.y0, r.bbox.x0))
        columns.append(
            TextColumn(bbox=_enclosing_bbox(bucket), runs=tuple(bucket))
        )
    return tuple(columns)


def _filter_to_body_text(runs: tuple[TextRun, ...]) -> tuple[TextRun, ...]:
    if not runs:
        return runs
    sizes = Counter(round(r.font_size * 2) / 2 for r in runs)
    body_candidates = {s: n for s, n in sizes.items() if s >= MIN_BODY_FONT_PT}
    if not body_candidates:
        return runs
    mode_size = max(body_candidates, key=lambda s: body_candidates[s])
    mode_count = body_candidates[mode_size]
    if mode_count < len(runs) * MIN_BODY_RUN_RATIO:
        return runs
    tol = max(0.5, mode_size * BODY_FONT_TOLERANCE_PCT)
    return tuple(r for r in runs if abs(r.font_size - mode_size) <= tol)


def _detect_column_boundaries(
    runs: tuple[TextRun, ...],
    page_width_pt: float,
    max_columns: int,
) -> list[float]:
    if len(runs) < 2:
        return []

    bucket_counts: dict[float, int] = defaultdict(int)
    for run in runs:
        b = int(run.bbox.x0 // BUCKET_SIZE_PT) * BUCKET_SIZE_PT
        bucket_counts[b] += 1

    threshold = max(3, int(len(runs) ** 0.5))
    candidates = sorted(
        [(x, n) for x, n in bucket_counts.items() if n >= threshold],
        key=lambda c: c[0],
    )
    if len(candidates) < 2:
        return []
    if len(candidates) > max_columns:
        candidates = sorted(candidates, key=lambda c: -c[1])[:max_columns]
        candidates.sort(key=lambda c: c[0])

    if len(candidates) >= 3:
        gaps = [
            candidates[i + 1][0] - candidates[i][0]
            for i in range(len(candidates) - 1)
        ]
        mean_gap = sum(gaps) / len(gaps)
        uniform = mean_gap > 0 and all(
            abs(g - mean_gap) / mean_gap <= UNIFORM_GAP_TOLERANCE for g in gaps
        )
        if not uniform:
            candidates = sorted(candidates, key=lambda c: -c[1])[:2]
            candidates.sort(key=lambda c: c[0])

    peak_xs = [c[0] for c in candidates]
    min_gap = min(peak_xs[i + 1] - peak_xs[i] for i in range(len(peak_xs) - 1))
    if min_gap < MIN_COLUMN_GAP_PT:
        return []

    return [peak_xs[i + 1] for i in range(len(peak_xs) - 1)]


def _single_column(runs: tuple[TextRun, ...]) -> tuple[TextColumn, ...]:
    sorted_runs = sorted(runs, key=lambda r: (r.bbox.y0, r.bbox.x0))
    return (
        TextColumn(bbox=_enclosing_bbox(sorted_runs), runs=tuple(sorted_runs)),
    )


def _enclosing_bbox(runs: list[TextRun]) -> BBox:
    return BBox(
        x0=min(r.bbox.x0 for r in runs),
        y0=min(r.bbox.y0 for r in runs),
        x1=max(r.bbox.x1 for r in runs),
        y1=max(r.bbox.y1 for r in runs),
    )
