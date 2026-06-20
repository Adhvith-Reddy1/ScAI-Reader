from __future__ import annotations

import pytest


def _upload(app_client, pdf_path, name="s.pdf"):
    with pdf_path.open("rb") as f:
        return app_client.post(
            "/documents", files={"file": (name, f, "application/pdf")}
        ).json()["id"]


@pytest.mark.integration
def test_search_finds_known_term_with_page_index(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)

    # "fox" appears in "The quick brown fox jumps over the lazy dog." on page 1.
    r = app_client.get(f"/documents/{doc_id}/search", params={"q": "fox"})
    assert r.status_code == 200
    body = r.json()
    assert body["doc_id"] == doc_id
    assert body["query"] == "fox"
    assert len(body["results"]) >= 1
    assert body["results"][0]["page"] == 1
    assert "<mark>" in body["results"][0]["snippet"]
    assert "fox" in body["results"][0]["snippet"].lower()


@pytest.mark.integration
def test_search_returns_correct_page_for_page_two_term(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)

    # "Second" only appears on page 2 ("Second page content for...").
    r = app_client.get(f"/documents/{doc_id}/search", params={"q": "Second"})
    assert r.status_code == 200
    pages = [hit["page"] for hit in r.json()["results"]]
    assert pages == [2]


@pytest.mark.integration
def test_search_404_for_unknown_doc(app_client):
    r = app_client.get("/documents/deadbeef/search", params={"q": "anything"})
    assert r.status_code == 404


@pytest.mark.integration
def test_search_empty_results_for_absent_term(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    r = app_client.get(
        f"/documents/{doc_id}/search", params={"q": "zzzzznotinthisdocument"}
    )
    assert r.status_code == 200
    assert r.json()["results"] == []


@pytest.mark.integration
def test_search_empty_query_returns_empty_results(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    r = app_client.get(f"/documents/{doc_id}/search", params={"q": "   "})
    assert r.status_code == 200
    assert r.json()["results"] == []


@pytest.mark.integration
def test_search_respects_limit(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    # "page" appears on both fixture pages.
    r = app_client.get(
        f"/documents/{doc_id}/search", params={"q": "page", "limit": 1}
    )
    assert r.status_code == 200
    assert len(r.json()["results"]) <= 1


@pytest.mark.integration
def test_reupload_does_not_duplicate_search_hits(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    _upload(app_client, simple_pdf)  # same SHA, re-upload
    r = app_client.get(f"/documents/{doc_id}/search", params={"q": "fox"})
    assert r.status_code == 200
    # "fox" appears once on page 1, so there should be exactly one hit even
    # after re-upload (the FTS index is rebuilt, not appended).
    assert len(r.json()["results"]) == 1
