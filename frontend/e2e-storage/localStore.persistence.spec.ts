import { expect, test } from "@playwright/test";

// Real-browser proof of Spec 02's central claim: IndexedDB is durable across a
// page reload. jsdom + fake-indexeddb can re-open a fake DB within one process,
// but only a real browser proves data survives an actual navigation/reload.
//
// We import the production module straight from Vite's dev server inside the
// page, so this exercises the exact `localStore.ts` that ships — no test double.

const MODULE_URL = "/src/storage/localStore.ts";

test("documents, annotations, explanations and viewState persist across reload", async ({
  page,
}) => {
  // Vite serves index.html at "/"; we just need a same-origin page to import from.
  await page.goto("/");

  // --- Session 1: write a document with related data through the real module.
  await page.evaluate(async (modUrl) => {
    const s = await import(modUrl);
    await s.putDocument({
      id: "doc-e2e",
      filename: "e2e.pdf",
      page_count: 2,
      title: "E2E Doc",
      author: null,
      size_bytes: 4,
      added_at: "2026-01-01T00:00:00.000Z",
      blob: new Blob([new Uint8Array([1, 2, 3, 4])], {
        type: "application/pdf",
      }),
    });
    await s.putAnnotation({
      id: "ann-e2e",
      docId: "doc-e2e",
      page: 1,
      kind: "highlight",
      color: "yellow",
      rects: [{ x0: 0, y0: 0, x1: 1, y1: 1 }],
      text: "hello",
      explain: true,
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await s.putExplanation({
      docId: "doc-e2e",
      annotationId: "ann-e2e",
      kind: "definition",
      text: "hello",
      content: "a greeting",
      status: "complete",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    await s.putViewState({
      docId: "doc-e2e",
      lastPage: 2,
      zoom: 1.25,
      sidebarOpen: true,
    });
  }, MODULE_URL);

  // --- Hard reload: a brand-new document, a brand-new IndexedDB connection.
  await page.reload();

  // --- Session 2: read everything back; the blob must survive too.
  const readBack = await page.evaluate(async (modUrl) => {
    const s = await import(modUrl);
    const doc = await s.getDocument("doc-e2e");
    const anns = await s.listAnnotations("doc-e2e", 1);
    const expl = await s.getExplanation("doc-e2e", "ann-e2e");
    const vs = await s.getViewState("doc-e2e");
    return {
      filename: doc?.filename ?? null,
      blobSize: doc?.blob instanceof Blob ? doc.blob.size : -1,
      blobBytes: doc ? Array.from(new Uint8Array(await doc.blob.arrayBuffer())) : [],
      annIds: anns.map((a: { id: string }) => a.id),
      explContent: expl?.content ?? null,
      viewState: vs,
    };
  }, MODULE_URL);

  expect(readBack.filename).toBe("e2e.pdf");
  expect(readBack.blobSize).toBe(4);
  expect(readBack.blobBytes).toEqual([1, 2, 3, 4]);
  expect(readBack.annIds).toEqual(["ann-e2e"]);
  expect(readBack.explContent).toBe("a greeting");
  expect(readBack.viewState).toEqual({
    docId: "doc-e2e",
    lastPage: 2,
    zoom: 1.25,
    sidebarOpen: true,
  });
});

test("deleteDocument cascade survives a reload", async ({ page }) => {
  await page.goto("/");

  await page.evaluate(async (modUrl) => {
    const s = await import(modUrl);
    await s.putDocument({
      id: "doc-del",
      filename: "del.pdf",
      page_count: 1,
      title: null,
      author: null,
      size_bytes: 1,
      added_at: "2026-01-01T00:00:00.000Z",
      blob: new Blob([new Uint8Array([9])]),
    });
    await s.putAnnotation({
      id: "ann-del",
      docId: "doc-del",
      page: 1,
      kind: "highlight",
      color: "blue",
      rects: [],
      text: null,
      explain: false,
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await s.putExplanation({
      docId: "doc-del",
      annotationId: "ann-del",
      kind: "explanation",
      text: "x",
      content: "y",
      status: "complete",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    await s.putViewState({
      docId: "doc-del",
      lastPage: 1,
      zoom: 1,
      sidebarOpen: false,
    });
    await s.deleteDocument("doc-del");
  }, MODULE_URL);

  await page.reload();

  const after = await page.evaluate(async (modUrl) => {
    const s = await import(modUrl);
    return {
      doc: await s.getDocument("doc-del"),
      anns: (await s.listAnnotations("doc-del")).length,
      expl: await s.getExplanation("doc-del", "ann-del"),
      vs: await s.getViewState("doc-del"),
    };
  }, MODULE_URL);

  expect(after.doc).toBeNull();
  expect(after.anns).toBe(0);
  expect(after.expl).toBeNull();
  expect(after.vs).toBeNull();
});
