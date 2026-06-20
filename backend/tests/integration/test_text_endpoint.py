from __future__ import annotations

import pytest


@pytest.mark.integration
def test_text_endpoint_returns_columns(app_client, two_column_pdf):
    with two_column_pdf.open("rb") as f:
        doc_id = app_client.post(
            "/documents", files={"file": ("tc.pdf", f, "application/pdf")}
        ).json()["id"]

    r = app_client.get(f"/documents/{doc_id}/pages/1/text")
    assert r.status_code == 200
    body = r.json()
    assert body["page_width_pt"] > 0
    assert body["page_height_pt"] > 0
    assert len(body["columns"]) == 2

    left_text = "".join(run["text"] for run in body["columns"][0]["runs"])
    right_text = "".join(run["text"] for run in body["columns"][1]["runs"])
    assert "Left column" in left_text
    assert "Right column" in right_text


@pytest.mark.integration
def test_text_endpoint_404_for_unknown_doc(app_client):
    r = app_client.get("/documents/deadbeef/pages/1/text")
    assert r.status_code == 404


@pytest.mark.integration
def test_text_endpoint_400_for_bad_page(app_client, simple_pdf):
    with simple_pdf.open("rb") as f:
        doc_id = app_client.post(
            "/documents", files={"file": ("s.pdf", f, "application/pdf")}
        ).json()["id"]
    r = app_client.get(f"/documents/{doc_id}/pages/99/text")
    assert r.status_code == 400


@pytest.mark.integration
def test_text_endpoint_bboxes_inside_page(app_client, simple_pdf):
    with simple_pdf.open("rb") as f:
        doc_id = app_client.post(
            "/documents", files={"file": ("s.pdf", f, "application/pdf")}
        ).json()["id"]
    body = app_client.get(f"/documents/{doc_id}/pages/1/text").json()
    pw, ph = body["page_width_pt"], body["page_height_pt"]
    for col in body["columns"]:
        for run in col["runs"]:
            b = run["bbox"]
            assert 0 <= b["x0"] <= b["x1"] <= pw + 1
            assert 0 <= b["y0"] <= b["y1"] <= ph + 1
