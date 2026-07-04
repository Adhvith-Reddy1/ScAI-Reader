import { expect, test } from "@playwright/test";

// The whole feature, proven in a real browser: a reader annotates a PDF, embeds
// the bundle into the file, "sends" it to a friend (a fresh browser with empty
// IndexedDB and a mocked /ai/explain that must NOT be called), who opens it and
// gets the same highlight + explanation with zero LLM calls.

const BUNDLE_URL = "/src/storage/portableBundle.ts";
const SIDECAR_URL = "/src/storage/pdfSidecar.ts";
const STORE_URL = "/src/explanationStore.ts";
const LOCAL_URL = "/src/storage/localStore.ts";

test("annotated PDF carries its explanation to a fresh browser, no AI call", async ({
  page,
}) => {
  // The friend's app must never regenerate — fail loudly if /ai/explain is hit.
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

  // --- Author: seed an annotation + explanation, export, embed into a PDF.
  const embedded = await page.evaluate(
    async ({ bundleUrl, sidecarUrl, localUrl }) => {
      const local = await import(localUrl);
      const bundleMod = await import(bundleUrl);
      const sidecar = await import(sidecarUrl);

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

      const bundle = await bundleMod.exportBundle(
        docId,
        "2026-07-04T00:00:00.000Z",
        "paper.pdf",
      );
      const pdf = new TextEncoder().encode("%PDF-1.7\n...\n%%EOF\n");
      const withBundle = sidecar.embedBundleInPdf(
        pdf,
        bundleMod.serializeBundle(bundle),
      );
      // Hand the embedded bytes back to the test as a plain array.
      return Array.from(withBundle);
    },
    { bundleUrl: BUNDLE_URL, sidecarUrl: SIDECAR_URL, localUrl: LOCAL_URL },
  );

  expect(embedded.length).toBeGreaterThan(0);

  // --- "Send" the file: wipe IndexedDB so this is effectively a new browser.
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase("scai-reader");
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
  await page.reload();

  // --- Friend: open the file. Extract + import the bundle under the id the
  // friend computes for the file they received, then read the explanation back.
  const restored = await page.evaluate(
    async ({ bundleUrl, sidecarUrl, storeUrl, bytes }) => {
      const bundleMod = await import(bundleUrl);
      const sidecar = await import(sidecarUrl);
      const store = await import(storeUrl);

      const received = new Uint8Array(bytes);
      // The received file's id differs from the original (embedding changed the
      // bytes); import re-keys the bundle to this id.
      const friendDocId = "doc-received";
      const json = sidecar.extractBundleFromPdf(received);
      if (!json) return { error: "no bundle found" };
      const bundle = bundleMod.parseBundle(json);
      await bundleMod.importBundle(bundle, friendDocId);

      // Cache-first hydrate — this is the hover path; it must resolve from the
      // imported cache without touching the network.
      const hydrated = await store.hydrateExplanation(friendDocId, "ann-1");
      const state = store.getExplanationState("ann-1");
      return {
        hydrated,
        status: state.status,
        content: "content" in state ? state.content : null,
        originalDocId: bundle.docId,
      };
    },
    {
      bundleUrl: BUNDLE_URL,
      sidecarUrl: SIDECAR_URL,
      storeUrl: STORE_URL,
      bytes: embedded,
    },
  );

  expect(restored.originalDocId).toBe("doc-orig");
  expect(restored.hydrated).toBe(true);
  expect(restored.status).toBe("ready");
  expect(restored.content).toBe("A measure of disorder.");
  // The friend's explanation was restored from the file, not regenerated.
  expect(aiCalls).toBe(0);
});
