"""End-to-end integration tests over the FastAPI app using TestClient.

Each test gets an isolated tmp data dir via the ``app_client`` fixture; no
mocks of pypdfium2 or SQLite. Real upload → list → render flows.
"""

from __future__ import annotations

import hashlib

import pytest


@pytest.mark.integration
def test_health_endpoint(app_client):
    r = app_client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


@pytest.mark.integration
def test_upload_then_list(app_client, simple_pdf):
    with simple_pdf.open("rb") as f:
        r = app_client.post(
            "/documents",
            files={"file": ("simple.pdf", f, "application/pdf")},
        )
    assert r.status_code == 200, r.text
    body = r.json()

    expected_id = hashlib.sha256(simple_pdf.read_bytes()).hexdigest()
    assert body["id"] == expected_id
    assert body["page_count"] == 2
    assert body["title"] == "Simple Two Page"

    listing = app_client.get("/documents").json()
    assert len(listing) == 1
    assert listing[0]["id"] == expected_id


@pytest.mark.integration
def test_upload_rejects_non_pdf(app_client):
    r = app_client.post(
        "/documents",
        files={"file": ("nope.pdf", b"definitely not a pdf", "application/pdf")},
    )
    assert r.status_code == 400


@pytest.mark.integration
def test_upload_rejects_empty(app_client):
    r = app_client.post(
        "/documents",
        files={"file": ("empty.pdf", b"", "application/pdf")},
    )
    assert r.status_code == 400


@pytest.mark.integration
def test_render_page_returns_png(app_client, simple_pdf):
    with simple_pdf.open("rb") as f:
        upload = app_client.post(
            "/documents",
            files={"file": ("simple.pdf", f, "application/pdf")},
        ).json()
    doc_id = upload["id"]

    r = app_client.get(f"/documents/{doc_id}/pages/1.png?dpi=72")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.content.startswith(b"\x89PNG\r\n\x1a\n")


@pytest.mark.integration
def test_render_page_is_cached(app_client, simple_pdf, tmp_settings):
    with simple_pdf.open("rb") as f:
        upload = app_client.post(
            "/documents",
            files={"file": ("simple.pdf", f, "application/pdf")},
        ).json()
    doc_id = upload["id"]

    app_client.get(f"/documents/{doc_id}/pages/1.png?dpi=72")
    cached = tmp_settings.render_cache_dir / doc_id / "p0_72.png"
    assert cached.exists()

    r2 = app_client.get(f"/documents/{doc_id}/pages/1.png?dpi=72")
    assert r2.status_code == 200
    assert r2.content == cached.read_bytes()


@pytest.mark.integration
def test_render_unknown_doc_is_404(app_client):
    r = app_client.get("/documents/deadbeef/pages/1.png")
    assert r.status_code == 404


@pytest.mark.integration
def test_render_invalid_dpi_is_400(app_client, simple_pdf):
    with simple_pdf.open("rb") as f:
        doc_id = app_client.post(
            "/documents",
            files={"file": ("s.pdf", f, "application/pdf")},
        ).json()["id"]
    assert app_client.get(f"/documents/{doc_id}/pages/1.png?dpi=0").status_code == 400
    assert app_client.get(f"/documents/{doc_id}/pages/1.png?dpi=9999").status_code == 400


@pytest.mark.integration
def test_get_document_metadata(app_client, simple_pdf):
    with simple_pdf.open("rb") as f:
        doc_id = app_client.post(
            "/documents",
            files={"file": ("s.pdf", f, "application/pdf")},
        ).json()["id"]
    r = app_client.get(f"/documents/{doc_id}")
    assert r.status_code == 200
    body = r.json()
    assert body["page_count"] == 2
    assert body["title"] == "Simple Two Page"


@pytest.mark.integration
def test_duplicate_upload_is_idempotent(app_client, simple_pdf):
    """SHA-keyed storage means the same bytes always resolve to the same id."""
    with simple_pdf.open("rb") as f:
        a = app_client.post("/documents", files={"file": ("a.pdf", f, "application/pdf")})
    with simple_pdf.open("rb") as f:
        b = app_client.post("/documents", files={"file": ("b.pdf", f, "application/pdf")})
    assert a.json()["id"] == b.json()["id"]
    listing = app_client.get("/documents").json()
    assert len(listing) == 1
