import { test, expect } from "@playwright/test";

// Smoke test: the single-server app boots, serves the SPA, and the reader
// shell renders. This is the baseline we build on — every feature test should
// be able to assume the app at least gets this far.
test("app loads and renders the reader shell", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("ScAI-Reader");
  await expect(page.locator(".brand")).toHaveText("ScAI-Reader");
  await expect(page.getByText("Open PDF…", { exact: true })).toBeVisible();

  // The viewer starts on "Loading library…"; once the backend responds it
  // should settle into the empty-library state rather than hang.
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator(".library-empty")).toContainText("No documents yet");
});

test("backend health endpoint is reachable", async ({ request }) => {
  const res = await request.get("/healthz");
  expect(res.ok()).toBeTruthy();
  expect(await res.json()).toEqual({ ok: true });
});
