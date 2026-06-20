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
def test_dimensions_endpoint_returns_per_page_sizes(app_client, simple_pdf):
    with simple_pdf.open("rb") as f:
        doc_id = app_client.post(
            "/documents", files={"file": ("s.pdf", f, "application/pdf")}
        ).json()["id"]

    r = app_client.get(f"/documents/{doc_id}/dimensions")
    assert r.status_code == 200
    body = r.json()
    assert body["doc_id"] == doc_id
    assert len(body["pages"]) == 2
    assert body["pages"][0]["page"] == 1
    assert body["pages"][0]["width_pt"] > 0
    assert body["pages"][0]["height_pt"] > 0


@pytest.mark.integration
def test_dimensions_endpoint_404_on_unknown_doc(app_client):
    r = app_client.get("/documents/deadbeef/dimensions")
    assert r.status_code == 404


@pytest.mark.integration
def test_dimensions_lazy_populates_for_legacy_docs(app_client, simple_pdf, tmp_settings):
    """Docs uploaded before the dimensions table existed have no cached rows.
    The endpoint must still answer correctly by computing on demand."""
    from app.storage import db

    with simple_pdf.open("rb") as f:
        doc_id = app_client.post(
            "/documents", files={"file": ("s.pdf", f, "application/pdf")}
        ).json()["id"]

    # Simulate a pre-upgrade doc by wiping the cached rows.
    with db.connect(tmp_settings.db_path) as conn:
        conn.execute("DELETE FROM page_dimensions WHERE doc_id = ?", (doc_id,))

    r = app_client.get(f"/documents/{doc_id}/dimensions")
    assert r.status_code == 200
    assert len(r.json()["pages"]) == 2

    # And now the rows should be backfilled.
    with db.connect(tmp_settings.db_path) as conn:
        count = conn.execute(
            "SELECT COUNT(*) AS n FROM page_dimensions WHERE doc_id = ?", (doc_id,)
        ).fetchone()["n"]
    assert count == 2


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
