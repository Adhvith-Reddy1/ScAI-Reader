from __future__ import annotations

import pytest


def _upload(client, pdf_path):
    with pdf_path.open("rb") as f:
        return client.post(
            "/documents", files={"file": ("s.pdf", f, "application/pdf")}
        ).json()["id"]


_DEFAULT_RECT = [{"x0": 72.0, "y0": 100.0, "x1": 300.0, "y1": 112.0}]


def _highlight(page=1, color="yellow", rects=None):
    return {
        "page": page,
        "color": color,
        "rects": _DEFAULT_RECT if rects is None else rects,
    }


@pytest.mark.integration
def test_create_highlight(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    r = app_client.post(f"/documents/{doc_id}/annotations", json=_highlight())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["color"] == "yellow"
    assert body["page"] == 1
    assert body["kind"] == "highlight"
    assert len(body["rects"]) == 1
    assert body["id"]


@pytest.mark.integration
@pytest.mark.parametrize("color", ["yellow", "blue", "red", "green", "pink"])
def test_each_palette_color_accepted(app_client, simple_pdf, color):
    doc_id = _upload(app_client, simple_pdf)
    r = app_client.post(
        f"/documents/{doc_id}/annotations", json=_highlight(color=color)
    )
    assert r.status_code == 200, r.text


@pytest.mark.integration
def test_invalid_color_rejected(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    r = app_client.post(
        f"/documents/{doc_id}/annotations", json=_highlight(color="orange")
    )
    assert r.status_code == 422


@pytest.mark.integration
def test_empty_rects_rejected(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    r = app_client.post(
        f"/documents/{doc_id}/annotations", json=_highlight(rects=[])
    )
    assert r.status_code == 422


@pytest.mark.integration
def test_create_on_unknown_doc_404(app_client):
    r = app_client.post(
        "/documents/deadbeef/annotations", json=_highlight()
    )
    assert r.status_code == 404


@pytest.mark.integration
def test_list_returns_created(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    a1 = app_client.post(
        f"/documents/{doc_id}/annotations", json=_highlight(color="yellow")
    ).json()["id"]
    a2 = app_client.post(
        f"/documents/{doc_id}/annotations", json=_highlight(color="blue", page=2)
    ).json()["id"]

    all_anns = app_client.get(f"/documents/{doc_id}/annotations").json()
    ids = {a["id"] for a in all_anns}
    assert ids == {a1, a2}


@pytest.mark.integration
def test_list_filtered_by_page(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    app_client.post(
        f"/documents/{doc_id}/annotations", json=_highlight(page=1, color="yellow")
    )
    app_client.post(
        f"/documents/{doc_id}/annotations", json=_highlight(page=2, color="blue")
    )

    page1 = app_client.get(f"/documents/{doc_id}/annotations?page=1").json()
    page2 = app_client.get(f"/documents/{doc_id}/annotations?page=2").json()
    assert len(page1) == 1 and page1[0]["color"] == "yellow"
    assert len(page2) == 1 and page2[0]["color"] == "blue"


@pytest.mark.integration
def test_delete_removes_annotation(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    aid = app_client.post(
        f"/documents/{doc_id}/annotations", json=_highlight()
    ).json()["id"]

    r = app_client.delete(f"/documents/{doc_id}/annotations/{aid}")
    assert r.status_code == 204

    remaining = app_client.get(f"/documents/{doc_id}/annotations").json()
    assert remaining == []


@pytest.mark.integration
def test_delete_unknown_404(app_client, simple_pdf):
    doc_id = _upload(app_client, simple_pdf)
    r = app_client.delete(f"/documents/{doc_id}/annotations/nope")
    assert r.status_code == 404


@pytest.mark.integration
def test_reupload_preserves_existing_annotations(app_client, simple_pdf):
    """Regression: ``INSERT OR REPLACE INTO documents`` cascades into the
    annotations table via the foreign key, wiping every highlight on a
    re-upload of the same PDF. The route must UPSERT without DELETE."""
    doc_id = _upload(app_client, simple_pdf)
    aid = app_client.post(
        f"/documents/{doc_id}/annotations",
        json=_highlight(color="green"),
    ).json()["id"]
    assert app_client.get(f"/documents/{doc_id}/annotations").json()[0]["id"] == aid

    # Re-upload the same file. doc_id should match (SHA-keyed); annotations
    # must still be there.
    re_uploaded_id = _upload(app_client, simple_pdf)
    assert re_uploaded_id == doc_id

    survivors = app_client.get(f"/documents/{doc_id}/annotations").json()
    assert len(survivors) == 1
    assert survivors[0]["id"] == aid
    assert survivors[0]["color"] == "green"


@pytest.mark.integration
def test_persistence_across_independent_request_chain(app_client, simple_pdf):
    """Annotations stored once must be visible to a later GET — proves storage,
    not just in-memory state, is doing the work (no cache hiding bugs)."""
    doc_id = _upload(app_client, simple_pdf)
    aid = app_client.post(
        f"/documents/{doc_id}/annotations",
        json=_highlight(color="red", rects=[
            {"x0": 50.0, "y0": 50.0, "x1": 200.0, "y1": 65.0},
            {"x0": 50.0, "y0": 70.0, "x1": 220.0, "y1": 85.0},
        ]),
    ).json()["id"]

    fetched = app_client.get(f"/documents/{doc_id}/annotations?page=1").json()
    assert len(fetched) == 1
    a = fetched[0]
    assert a["id"] == aid
    assert a["color"] == "red"
    assert len(a["rects"]) == 2
    assert a["rects"][0]["x0"] == 50.0
    assert a["rects"][1]["y1"] == 85.0
