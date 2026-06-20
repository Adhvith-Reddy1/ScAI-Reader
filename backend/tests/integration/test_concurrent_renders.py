"""Regression test for the PDFium thread-safety segfault.

When a multi-page PDF is opened in the browser, the frontend immediately
fires one image request per page. FastAPI dispatches each sync handler to a
threadpool worker, so without serialization those calls race inside libpdfium
and segfault the process. This test asserts the lock around PDFium prevents
the crash and that every render returns a valid PNG.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest


@pytest.mark.integration
def test_parallel_page_renders_do_not_crash(app_client, simple_pdf):
    with simple_pdf.open("rb") as f:
        doc_id = app_client.post(
            "/documents",
            files={"file": ("s.pdf", f, "application/pdf")},
        ).json()["id"]

    def fetch(page: int) -> tuple[int, bytes]:
        r = app_client.get(f"/documents/{doc_id}/pages/{page}.png?dpi=100")
        return r.status_code, r.content

    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(fetch, [p for p in range(1, 3) for _ in range(16)]))

    assert all(status == 200 for status, _ in results)
    for _, body in results:
        assert body.startswith(b"\x89PNG\r\n\x1a\n")
