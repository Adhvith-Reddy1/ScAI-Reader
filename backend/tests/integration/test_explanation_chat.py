"""Tests for the explanation chat + refine endpoints.

These cover validation, ownership, and the no-API-key streaming path. The
happy-path (a real model rewrite) needs ANTHROPIC_API_KEY and a live call, so
the persistence logic is exercised directly against `_save_refined` instead.
"""

from __future__ import annotations

import pytest


def _upload(client, pdf_path):
    with pdf_path.open("rb") as f:
        return client.post(
            "/documents", files={"file": ("s.pdf", f, "application/pdf")}
        ).json()["id"]


def _make_highlight(client, doc_id, color="blue"):
    rects = [{"x0": 72.0, "y0": 100.0, "x1": 300.0, "y1": 112.0}]
    r = client.post(
        f"/documents/{doc_id}/annotations",
        json={"page": 1, "color": color, "rects": rects, "text": "entropy"},
    )
    return r.json()["id"]


def _chat_body(**over):
    body = {
        "text": "entropy",
        "kind": "definition",
        "content": "A measure of disorder.",
        "messages": [{"role": "user", "content": "How does it relate here?"}],
    }
    body.update(over)
    return body


def _sse_text(response) -> str:
    return response.text


@pytest.fixture(autouse=True)
def _no_api_key(monkeypatch):
    # Force the deterministic "no key" branch so tests don't hit the network.
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


@pytest.mark.integration
def test_chat_unknown_document_404(app_client):
    r = app_client.post(
        "/documents/nope/annotations/whatever/chat", json=_chat_body()
    )
    assert r.status_code == 404


@pytest.mark.integration
def test_chat_unknown_annotation_404(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    r = app_client.post(
        f"/documents/{doc_id}/annotations/missing/chat", json=_chat_body()
    )
    assert r.status_code == 404


@pytest.mark.integration
def test_chat_empty_messages_rejected(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    ann_id = _make_highlight(app_client, doc_id)
    r = app_client.post(
        f"/documents/{doc_id}/annotations/{ann_id}/chat",
        json=_chat_body(messages=[]),
    )
    assert r.status_code == 422


@pytest.mark.integration
def test_chat_without_key_streams_error(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    ann_id = _make_highlight(app_client, doc_id)
    r = app_client.post(
        f"/documents/{doc_id}/annotations/{ann_id}/chat", json=_chat_body()
    )
    assert r.status_code == 200
    body = _sse_text(r)
    assert '"type": "meta"' in body
    assert "ANTHROPIC_API_KEY not set" in body


@pytest.mark.integration
def test_refine_unknown_annotation_404(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    r = app_client.post(
        f"/documents/{doc_id}/annotations/missing/refine", json=_chat_body()
    )
    assert r.status_code == 404


@pytest.mark.integration
def test_refine_without_key_does_not_overwrite(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    ann_id = _make_highlight(app_client, doc_id)

    r = app_client.post(
        f"/documents/{doc_id}/annotations/{ann_id}/refine", json=_chat_body()
    )
    assert r.status_code == 200
    assert "ANTHROPIC_API_KEY not set" in _sse_text(r)

    # A failed refine must not have written a (bogus) explanation row.
    got = app_client.get(
        f"/documents/{doc_id}/annotations/{ann_id}/explanation"
    )
    assert got.status_code == 404


@pytest.mark.integration
def test_explain_uses_page_text_path_and_streams_error(app_client, simple_pdf):
    # Exercises the new page-text context path end to end: extract the page,
    # then (no API key) emit the structured error.
    doc_id = _upload(app_client, simple_pdf)
    ann_id = _make_highlight(app_client, doc_id, color="blue")
    r = app_client.post(
        f"/documents/{doc_id}/annotations/{ann_id}/explain",
        json={"text": "entropy"},
    )
    assert r.status_code == 200
    body = _sse_text(r)
    assert '"type": "meta"' in body
    assert "ANTHROPIC_API_KEY not set" in body


@pytest.mark.integration
def test_explain_unknown_annotation_404(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    r = app_client.post(
        f"/documents/{doc_id}/annotations/missing/explain",
        json={"text": "x"},
    )
    assert r.status_code == 404


@pytest.mark.integration
def test_page_text_extraction_returns_page_content(app_client, simple_pdf):
    """The page-text helper should return the page's words for grounding."""
    from app.routes import explanations
    from app.routes.deps import get_settings

    settings = app_client.app.dependency_overrides[get_settings]()
    doc_id = _upload(app_client, simple_pdf)
    text = explanations._page_text(settings, doc_id, 0)
    assert isinstance(text, str)
    assert len(text.strip()) > 0


@pytest.mark.integration
def test_save_refined_persists_and_is_served(tmp_settings):
    """The success branch of refine calls _save_refined; verify it upserts a
    complete explanation that the GET endpoint then returns."""
    from app.routes import explanations
    from app.storage import db

    db.init_db(tmp_settings.db_path)

    annotation_id = "ann-1"
    with db.connect(tmp_settings.db_path) as conn:
        # Seed a document + annotation so the FK + ownership checks pass.
        conn.execute(
            "INSERT INTO documents (id, filename, page_count, title, author, "
            "size_bytes, uploaded_at) VALUES (?,?,?,?,?,?,?)",
            ("doc-1", "s.pdf", 1, None, None, 10, "2026-01-01T00:00:00Z"),
        )
        conn.execute(
            "INSERT INTO annotations (id, doc_id, page_index, kind, payload, "
            "created_at) VALUES (?,?,?,?,?,?)",
            (annotation_id, "doc-1", 0, "highlight", "{}", "2026-01-01T00:00:00Z"),
        )

    with db.connect(tmp_settings.db_path) as conn:
        explanations._save_refined(
            conn, annotation_id, "definition", "entropy", "Refined text."
        )

    with db.connect(tmp_settings.db_path) as conn:
        loaded = explanations._load_explanation(conn, annotation_id)
    assert loaded is not None
    assert loaded["status"] == "complete"
    assert loaded["content"] == "Refined text."
    assert loaded["kind"] == "definition"
