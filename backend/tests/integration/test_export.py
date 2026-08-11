"""Download-with-highlights round trip: export embeds annotations +
explanations as a PDF attachment; re-uploading that PDF hands them back so
the client can re-seed its local stores (see routes/export.py docstring)."""

from __future__ import annotations

import io

import pypdf
import pytest


ANNOTATIONS = [
    {
        "id": "ann-1",
        "docId": "will-be-overwritten",
        "page": 1,
        "kind": "highlight",
        "color": "blue",
        "rects": [{"x0": 10.0, "y0": 20.0, "x1": 100.0, "y1": 40.0}],
        "text": "a term",
        "explain": True,
        "created_at": "2026-01-01T00:00:00Z",
    }
]

EXPLANATIONS = [
    {
        "docId": "will-be-overwritten",
        "annotationId": "ann-1",
        "kind": "definition",
        "text": "a term",
        "content": "A tight definition of the term.",
        "status": "complete",
        "updated_at": "2026-01-01T00:00:01Z",
    }
]


@pytest.mark.integration
def test_export_404_for_unknown_doc(app_client):
    r = app_client.post(
        "/documents/deadbeef/export",
        json={"annotations": [], "explanations": []},
    )
    assert r.status_code == 404


@pytest.mark.integration
def test_export_returns_pdf_with_embedded_bundle(app_client, simple_pdf):
    with simple_pdf.open("rb") as f:
        upload = app_client.post(
            "/documents", files={"file": ("simple.pdf", f, "application/pdf")}
        )
    doc_id = upload.json()["id"]

    r = app_client.post(
        f"/documents/{doc_id}/export",
        json={
            "annotations": ANNOTATIONS,
            "explanations": EXPLANATIONS,
            "filename": "simple (highlighted).pdf",
        },
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert "highlighted" in r.headers["content-disposition"]

    # The output is still a normal, openable PDF with the same page content.
    reader = pypdf.PdfReader(io.BytesIO(r.content))
    assert len(reader.pages) == 2

    attached = reader.attachments.get("scai-reader-data.json")
    assert attached
    import json

    payload = json.loads(attached[0].decode("utf-8"))
    assert payload["format"] == "scai-reader-bundle"
    assert payload["annotations"] == ANNOTATIONS
    assert payload["explanations"] == EXPLANATIONS


@pytest.mark.integration
def test_reupload_of_exported_pdf_returns_bundle(app_client, simple_pdf):
    with simple_pdf.open("rb") as f:
        upload = app_client.post(
            "/documents", files={"file": ("simple.pdf", f, "application/pdf")}
        )
    doc_id = upload.json()["id"]

    export = app_client.post(
        f"/documents/{doc_id}/export",
        json={"annotations": ANNOTATIONS, "explanations": EXPLANATIONS},
    )
    assert export.status_code == 200

    # Simulate a friend opening the downloaded file: it's a brand-new upload
    # (different SHA-256 since bytes now include the attachment).
    reupload = app_client.post(
        "/documents",
        files={"file": ("shared.pdf", export.content, "application/pdf")},
    )
    assert reupload.status_code == 200, reupload.text
    body = reupload.json()
    assert body["id"] != doc_id
    assert body["scai_bundle"] == {
        "annotations": ANNOTATIONS,
        "explanations": EXPLANATIONS,
    }


@pytest.mark.integration
def test_plain_pdf_upload_has_no_bundle(app_client, simple_pdf):
    with simple_pdf.open("rb") as f:
        r = app_client.post(
            "/documents", files={"file": ("simple.pdf", f, "application/pdf")}
        )
    assert r.status_code == 200
    assert r.json()["scai_bundle"] is None


@pytest.mark.integration
def test_reopening_known_doc_still_returns_bundle(app_client, simple_pdf):
    """The fast path for an already-indexed doc (see upload_document) must
    still surface the bundle — a second person opening the same shared file
    within one server lifetime needs it too, not just the first."""
    with simple_pdf.open("rb") as f:
        upload = app_client.post(
            "/documents", files={"file": ("simple.pdf", f, "application/pdf")}
        )
    doc_id = upload.json()["id"]
    export = app_client.post(
        f"/documents/{doc_id}/export",
        json={"annotations": ANNOTATIONS, "explanations": EXPLANATIONS},
    )

    first = app_client.post(
        "/documents", files={"file": ("shared.pdf", export.content, "application/pdf")}
    )
    second = app_client.post(
        "/documents", files={"file": ("shared.pdf", export.content, "application/pdf")}
    )
    assert first.json()["id"] == second.json()["id"]
    assert second.json()["scai_bundle"] == {
        "annotations": ANNOTATIONS,
        "explanations": EXPLANATIONS,
    }


@pytest.mark.integration
def test_export_rejects_oversized_bundle(app_client, simple_pdf):
    with simple_pdf.open("rb") as f:
        upload = app_client.post(
            "/documents", files={"file": ("simple.pdf", f, "application/pdf")}
        )
    doc_id = upload.json()["id"]

    huge = [{"id": str(i)} for i in range(6000)]
    r = app_client.post(
        f"/documents/{doc_id}/export",
        json={"annotations": huge, "explanations": []},
    )
    assert r.status_code == 400
