"""Tests for the vision-LLM verification pass over the heuristic detector.

`figure_verify.verify_figures` sends the heuristic's guesses + the rendered
page to whichever provider is configured and merges back a JSON reply. These
tests stub `llm.stream_completion` so no network call happens, and exercise:
parsing a well-formed reply, correcting an existing box, adding a missed
figure, and degrading gracefully (no config, provider error, garbage reply)
back to the heuristic's own result unchanged.
"""

from __future__ import annotations

import asyncio

import pytest

from app import ai, llm
from app.pdf.figures import FigureRegion
from app.pdf.types import BBox
from app.routes import figure_verify as fv

PAGE_W = 600.0
PAGE_H = 800.0
CONFIG = ai.ProviderConfig(provider="anthropic", api_key="sk-ant-test")


def _run(coro):
    return asyncio.run(coro)


def _region(label: str, x0: float, y0: float, x1: float, y1: float) -> FigureRegion:
    bbox = BBox(x0=x0, y0=y0, x1=x1, y1=y1)
    return FigureRegion(
        figure_id=f"p0_{label}",
        label=label,
        page_index=0,
        bbox=bbox,
        caption_bbox=bbox,
    )


def _fake_stream(*frames):
    async def _gen(config, *, system, messages, max_tokens, tier="good"):
        for frame in frames:
            yield frame

    return _gen


# ---------------------------------------------------------------------------
# _parse_verified_items
# ---------------------------------------------------------------------------


def test_parse_well_formed_json_array():
    text = '[{"label": "Figure 1", "x0": 0.1, "y0": 0.2, "x1": 0.5, "y1": 0.4}]'
    items = fv._parse_verified_items(text)
    assert items == [{"label": "Figure 1", "coords": [0.1, 0.2, 0.5, 0.4]}]


def test_parse_tolerates_surrounding_prose_and_fences():
    text = 'Sure, here you go:\n```json\n[{"label": "Table 1", "x0": 0, "y0": 0, "x1": 1, "y1": 1}]\n```'
    items = fv._parse_verified_items(text)
    assert items == [{"label": "Table 1", "coords": [0, 0, 1, 1]}]


def test_parse_skips_malformed_entries_but_keeps_good_ones():
    text = (
        '[{"label": "Figure 1", "x0": 0.1, "y0": 0.1, "x1": 0.4, "y1": 0.4}, '
        '{"label": 5, "x0": 0, "y0": 0, "x1": 1, "y1": 1}, '
        '{"label": "Figure 2", "x0": "bad"}]'
    )
    items = fv._parse_verified_items(text)
    assert items == [{"label": "Figure 1", "coords": [0.1, 0.1, 0.4, 0.4]}]


def test_parse_returns_none_for_non_json():
    assert fv._parse_verified_items("not json at all") is None


def test_parse_empty_array_is_valid():
    assert fv._parse_verified_items("[]") == []


# ---------------------------------------------------------------------------
# verify_figures — merge behaviour
# ---------------------------------------------------------------------------


def test_no_config_returns_heuristic_unchanged():
    heuristic = [_region("Figure 1", 10, 10, 100, 100)]
    result = _run(fv.verify_figures(None, heuristic, b"png", 0, PAGE_W, PAGE_H))
    assert result == heuristic


def test_correction_replaces_bbox_for_matched_label(monkeypatch):
    heuristic = [_region("Figure 1", 10, 10, 50, 50)]
    reply = '[{"label": "Figure 1", "x0": 0.1, "y0": 0.1, "x1": 0.3, "y1": 0.3}]'
    monkeypatch.setattr(
        llm, "stream_completion", _fake_stream(("done", reply))
    )

    result = _run(fv.verify_figures(CONFIG, heuristic, b"png", 0, PAGE_W, PAGE_H))

    assert len(result) == 1
    assert result[0].label == "Figure 1"
    assert result[0].bbox.x0 == pytest.approx(0.1 * PAGE_W)
    assert result[0].bbox.y0 == pytest.approx(0.1 * PAGE_H)
    assert result[0].bbox.x1 == pytest.approx(0.3 * PAGE_W)
    assert result[0].bbox.y1 == pytest.approx(0.3 * PAGE_H)
    # Caption bbox carries over from the heuristic's original find for a
    # label the heuristic already had -- the model doesn't report captions.
    assert result[0].caption_bbox == heuristic[0].caption_bbox


def test_adds_a_figure_the_heuristic_missed(monkeypatch):
    heuristic = [_region("Figure 1", 10, 10, 50, 50)]
    reply = (
        '[{"label": "Figure 1", "x0": 0.01, "y0": 0.01, "x1": 0.08, "y1": 0.06}, '
        '{"label": "Figure 2", "x0": 0.5, "y0": 0.5, "x1": 0.9, "y1": 0.9}]'
    )
    monkeypatch.setattr(llm, "stream_completion", _fake_stream(("done", reply)))

    result = _run(fv.verify_figures(CONFIG, heuristic, b"png", 0, PAGE_W, PAGE_H))

    labels = {r.label for r in result}
    assert labels == {"Figure 1", "Figure 2"}
    added = next(r for r in result if r.label == "Figure 2")
    # No matching heuristic region to inherit a caption bbox from, so it
    # falls back to the figure's own bbox.
    assert added.caption_bbox == added.bbox


def test_label_the_reply_omits_is_kept_not_dropped(monkeypatch):
    heuristic = [
        _region("Figure 1", 10, 10, 50, 50),
        _region("Figure 2", 60, 60, 100, 100),
    ]
    # The reply only addresses Figure 1 -- Figure 2 must survive untouched.
    reply = '[{"label": "Figure 1", "x0": 0.1, "y0": 0.1, "x1": 0.2, "y1": 0.2}]'
    monkeypatch.setattr(llm, "stream_completion", _fake_stream(("done", reply)))

    result = _run(fv.verify_figures(CONFIG, heuristic, b"png", 0, PAGE_W, PAGE_H))

    labels = {r.label for r in result}
    assert labels == {"Figure 1", "Figure 2"}
    kept = next(r for r in result if r.label == "Figure 2")
    assert kept == heuristic[1]


def test_degenerate_bbox_from_reply_is_dropped(monkeypatch):
    heuristic = [_region("Figure 1", 10, 10, 50, 50)]
    # x1 == x0 -- zero width, well under MIN_FIGURE_DIMENSION_PT.
    reply = '[{"label": "Figure 2", "x0": 0.5, "y0": 0.5, "x1": 0.5, "y1": 0.9}]'
    monkeypatch.setattr(llm, "stream_completion", _fake_stream(("done", reply)))

    result = _run(fv.verify_figures(CONFIG, heuristic, b"png", 0, PAGE_W, PAGE_H))

    # The bogus addition is dropped; the untouched heuristic label survives.
    assert result == heuristic


def test_provider_error_falls_back_to_heuristic(monkeypatch):
    heuristic = [_region("Figure 1", 10, 10, 50, 50)]
    monkeypatch.setattr(
        llm, "stream_completion", _fake_stream(("error", "boom"))
    )

    result = _run(fv.verify_figures(CONFIG, heuristic, b"png", 0, PAGE_W, PAGE_H))

    assert result == heuristic


def test_unparseable_reply_falls_back_to_heuristic(monkeypatch):
    heuristic = [_region("Figure 1", 10, 10, 50, 50)]
    monkeypatch.setattr(
        llm, "stream_completion", _fake_stream(("done", "sorry, I can't help with that"))
    )

    result = _run(fv.verify_figures(CONFIG, heuristic, b"png", 0, PAGE_W, PAGE_H))

    assert result == heuristic
