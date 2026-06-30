import { expect, test } from "@playwright/test";

// Spec 06's central claim, proven in a real browser: a completed explanation is
// cached in IndexedDB and, after a reload, renders with ZERO new AI requests.
//
// We drive the production `explanationStore` straight from Vite's dev server and
// mock `/ai/explain` with `page.route`, counting how many times it is hit. The
// first explanation streams (1 call) and write-throughs to IndexedDB; after a
// reload the cache-first read serves it with no further call. No backend needed.

const STORE_URL = "/src/explanationStore.ts";

const SSE_BODY = [
  'data: {"type":"meta","kind":"definition","cached":false}',
  "",
  'data: {"type":"delta","text":"A measure "}',
  "",
  'data: {"type":"delta","text":"of disorder."}',
  "",
  'data: {"type":"done","text":"A measure of disorder."}',
  "",
  "",
].join("\n");

test("explanation caches across reload and serves with zero new AI calls", async ({
  page,
}) => {
  let aiCalls = 0;
  await page.route("**/ai/explain", async (route) => {
    aiCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: SSE_BODY,
    });
  });

  await page.goto("/");

  // --- Session 1: stream a fresh explanation; it should hit /ai/explain once.
  const first = await page.evaluate(async (storeUrl) => {
    const s = await import(storeUrl);
    await s.startExplanation("doc-e2e", "ann-e2e", "entropy", 1);
    // Wait for the stream to complete (onDone → ready).
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const st = s.getExplanationState("ann-e2e");
      if (st.status === "ready") return st.content;
      await new Promise((r) => setTimeout(r, 25));
    }
    return `TIMEOUT:${s.getExplanationState("ann-e2e").status}`;
  }, STORE_URL);

  expect(first).toBe("A measure of disorder.");
  expect(aiCalls).toBe(1);

  // --- Hard reload: fresh JS module state (the in-memory store is empty again),
  // but IndexedDB persists.
  await page.reload();

  // --- Session 2: starting the same explanation must serve from cache with no
  // new /ai/explain request.
  const second = await page.evaluate(async (storeUrl) => {
    const s = await import(storeUrl);
    // hydrate models the hover path; it must resolve from the cache.
    const hydrated = await s.hydrateExplanation("doc-e2e", "ann-e2e");
    // start again to prove the cache-first short-circuit also blocks the stream.
    await s.startExplanation("doc-e2e", "ann-e2e", "entropy", 1);
    const st = s.getExplanationState("ann-e2e");
    return { hydrated, status: st.status, content: st.content };
  }, STORE_URL);

  expect(second.hydrated).toBe(true);
  expect(second.status).toBe("ready");
  expect(second.content).toBe("A measure of disorder.");
  // The whole point: the second view made no new AI request.
  expect(aiCalls).toBe(1);
});
