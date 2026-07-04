import { expect, test } from "@playwright/test";

// The share feature exactly as main.ts drives it, in a real browser: build an
// annotated PDF from a real Blob (exercising Blob.arrayBuffer), "send" it to a
// fresh browser, import the embedded bundle on open, and confirm the explanation
// hydrates from cache with zero /ai/explain calls.

const SHARE_URL = "/src/share.ts";
const STORE_URL = "/src/explanationStore.ts";
const LOCAL_URL = "/src/storage/localStore.ts";

test("annotated PDF round-trips through the share module with no AI call", async ({
  page,
}) => {
  let aiCalls = 0;
  await page.route("**/ai/explain", async (route) => {
    aiCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: 'data: {"type":"done","text":"REGENERATED"}\n\n',
    });
  });

  await page.goto("/");

  // --- Author: seed a highlight + explanation, build the annotated PDF bytes.
  const annotatedBytes = await page.evaluate(
    async ({ shareUrl, localUrl }) => {
      const local = await import(localUrl);
      const share = await import(shareUrl);
      const docId = "doc-orig";
      await local.putAnnotation({
        id: "ann-1",
        docId,
        page: 1,
        kind: "highlight",
        color: "yellow",
        rects: [{ x0: 0, y0: 0, x1: 1, y1: 1 }],
        text: "entropy",
        explain: true,
        created_at: "2026-01-01T00:00:00.000Z",
      });
      await local.putExplanation({
        docId,
        annotationId: "ann-1",
        kind: "definition",
        text: "entropy",
        content: "A measure of disorder.",
        status: "complete",
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      const pdf = new Blob([new TextEncoder().encode("%PDF-1.7\n...\n%%EOF\n")], {
        type: "application/pdf",
      });
      const out = await share.buildAnnotatedPdf(docId, pdf, "paper.pdf", "now");
      return { filename: out.filename, bytes: Array.from(out.bytes) };
    },
    { shareUrl: SHARE_URL, localUrl: LOCAL_URL },
  );

  expect(annotatedBytes.filename).toBe("paper.annotated.pdf");

  // --- "Send": wipe IndexedDB so this is a brand-new browser.
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase("scai-reader");
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
  await page.reload();

  // --- Friend: import on open (re-keyed to the received file's id), then the
  // hover path (hydrate) must resolve from the restored cache.
  const restored = await page.evaluate(
    async ({ shareUrl, storeUrl, bytes }) => {
      const share = await import(shareUrl);
      const store = await import(storeUrl);
      const friendDocId = "doc-received";
      const outcome = await share.importEmbeddedBundle(
        new Uint8Array(bytes),
        friendDocId,
      );
      const hydrated = await store.hydrateExplanation(friendDocId, "ann-1");
      const st = store.getExplanationState("ann-1");
      return {
        outcome,
        hydrated,
        status: st.status,
        content: "content" in st ? st.content : null,
      };
    },
    { shareUrl: SHARE_URL, storeUrl: STORE_URL, bytes: annotatedBytes.bytes },
  );

  expect(restored.outcome).toEqual({ annotations: 1, explanations: 1 });
  expect(restored.hydrated).toBe(true);
  expect(restored.status).toBe("ready");
  expect(restored.content).toBe("A measure of disorder.");
  expect(aiCalls).toBe(0);
});
