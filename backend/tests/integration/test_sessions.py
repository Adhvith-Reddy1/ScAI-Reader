from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.routes.deps import SESSION_COOKIE, get_settings
from app.storage import db


def _app(tmp_settings):
    db.init_db(tmp_settings.db_path)
    app = create_app()
    app.dependency_overrides[get_settings] = lambda: tmp_settings
    return app


def _upload(client, pdf_path) -> str:
    with pdf_path.open("rb") as f:
        return client.post(
            "/documents", files={"file": ("s.pdf", f, "application/pdf")}
        ).json()["id"]


def _highlight(page=1, color="yellow"):
    return {
        "page": page,
        "color": color,
        "rects": [{"x0": 72.0, "y0": 100.0, "x1": 300.0, "y1": 112.0}],
    }


@pytest.mark.integration
def test_first_request_sets_session_cookie(tmp_settings):
    app = _app(tmp_settings)
    with TestClient(app) as c:
        c.get("/documents")
        assert c.cookies.get(SESSION_COOKIE)


@pytest.mark.integration
def test_library_is_per_session(tmp_settings, simple_pdf):
    app = _app(tmp_settings)
    with TestClient(app) as a, TestClient(app) as b:
        _upload(a, simple_pdf)
        assert len(a.get("/documents").json()) == 1
        # A different visitor sees an empty library.
        assert b.get("/documents").json() == []


@pytest.mark.integration
def test_annotations_are_per_session(tmp_settings, simple_pdf):
    app = _app(tmp_settings)
    with TestClient(app) as a, TestClient(app) as b:
        doc = _upload(a, simple_pdf)
        _upload(b, simple_pdf)  # same content → same doc_id, b's library too
        aid = a.post(f"/documents/{doc}/annotations", json=_highlight()).json()["id"]

        assert len(a.get(f"/documents/{doc}/annotations").json()) == 1
        assert b.get(f"/documents/{doc}/annotations").json() == []

        # B cannot delete A's highlight...
        assert b.delete(f"/documents/{doc}/annotations/{aid}").status_code == 404
        # ...but A can.
        assert a.delete(f"/documents/{doc}/annotations/{aid}").status_code == 204


@pytest.mark.integration
def test_highlight_cap_per_document(tmp_settings, simple_pdf):
    app = _app(tmp_settings)
    with TestClient(app) as a:
        doc = _upload(a, simple_pdf)
        for _ in range(50):
            r = a.post(f"/documents/{doc}/annotations", json=_highlight())
            assert r.status_code == 200, r.text
        # The 51st is rejected.
        r = a.post(f"/documents/{doc}/annotations", json=_highlight())
        assert r.status_code == 429
        assert "limit" in r.json()["detail"].lower()


@pytest.mark.integration
def test_cap_is_independent_per_session(tmp_settings, simple_pdf):
    # A hitting the cap doesn't block a different visitor B.
    app = _app(tmp_settings)
    with TestClient(app) as a, TestClient(app) as b:
        doc = _upload(a, simple_pdf)
        _upload(b, simple_pdf)
        for _ in range(50):
            a.post(f"/documents/{doc}/annotations", json=_highlight())
        assert a.post(f"/documents/{doc}/annotations", json=_highlight()).status_code == 429
        assert b.post(f"/documents/{doc}/annotations", json=_highlight()).status_code == 200
