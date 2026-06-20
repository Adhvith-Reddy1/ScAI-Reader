from __future__ import annotations

import pytest


def _upload(app_client, pdf_path, name: str = "doc.pdf") -> str:
    with pdf_path.open("rb") as f:
        r = app_client.post(
            "/documents", files={"file": (name, f, "application/pdf")}
        )
    assert r.status_code == 200
    return r.json()["id"]


@pytest.mark.integration
def test_outline_endpoint_returns_nested_tree(app_client, outline_pdf):
    doc_id = _upload(app_client, outline_pdf, "outline.pdf")

    r = app_client.get(f"/documents/{doc_id}/outline")
    assert r.status_code == 200
    body = r.json()
    assert body["doc_id"] == doc_id

    nodes = body["nodes"]
    assert [n["title"] for n in nodes] == ["Chapter 1", "Chapter 2"]
    # Pages are 1-indexed in the response.
    assert nodes[0]["page"] == 1
    assert nodes[1]["page"] == 3

    assert [c["title"] for c in nodes[0]["children"]] == ["1.1 Intro"]
    assert nodes[0]["children"][0]["page"] == 2
    assert nodes[0]["children"][0]["children"] == []

    assert [c["title"] for c in nodes[1]["children"]] == ["2.1 Methods"]
    assert nodes[1]["children"][0]["page"] == 4


@pytest.mark.integration
def test_outline_endpoint_404_for_unknown_doc(app_client):
    r = app_client.get("/documents/deadbeef/outline")
    assert r.status_code == 404


@pytest.mark.integration
def test_outline_endpoint_empty_for_doc_without_bookmarks(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf, "simple.pdf")
    r = app_client.get(f"/documents/{doc_id}/outline")
    assert r.status_code == 200
    body = r.json()
    assert body["doc_id"] == doc_id
    assert body["nodes"] == []
