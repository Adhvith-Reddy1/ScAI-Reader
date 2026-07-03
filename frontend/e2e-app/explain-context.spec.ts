import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { DATA_DIR } from "../playwright.app.config.ts";

// Regression test for the "inconsistent with the paper" bug: the server used
// to re-derive page context from its own copy of the uploaded PDF, held only
// in an ephemeral, disk-less cache. If that copy vanished — an idle
// scale-down, a restart, a redeploy — while a reader's tab stayed open on an
// already-rendered page, every explanation from then on was ungrounded and
// silently generic. The fix: the browser sends the page text it already
// fetched (to build the selectable text layer) directly in the request, so
// grounding never depends on the server's PDF still being there.
//
// This test proves it by deleting the server's on-disk PDF mid-session — the
// exact failure mode — and confirming the outgoing /ai/explain request still
// carries real page text.

const PDF_PATH = fileURLToPath(new URL("../../Animal_farm.pdf", import.meta.url));

test("explain request stays grounded in page text after the server's PDF cache is evicted", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#file").setInputFiles(PDF_PATH);
  await page.locator(".text-run").first().waitFor({ state: "attached" });

  // Page 1 is a sparse title page (just "Animal Farm" / "George Orwell" in a
  // large font) — dragging across it can select nothing but whitespace, which
  // isn't representative of how the feature is actually used. Jump to page 3
  // (real body-text paragraphs) so the drag reliably captures real text.
  await page.locator('[aria-label="Jump to page"]').fill("3");
  await page.locator('[aria-label="Jump to page"]').press("Enter");
  const pageWrap = page.locator(".page-wrap").nth(2);
  await pageWrap.locator(".text-run").first().waitFor({ state: "attached" });

  // What the browser actually rendered — this is the string the fix must
  // send along, independent of anything the server still has on disk.
  const runTexts = await pageWrap.locator(".text-run").allTextContents();
  const sampleText = runTexts.find((t) => t.trim().length > 8)?.trim();
  expect(sampleText).toBeTruthy();

  // Simulate the server losing its ephemeral PDF cache while this tab stays
  // open on an already-loaded page.
  const bytes = readFileSync(PDF_PATH);
  const docId = createHash("sha256").update(bytes).digest("hex");
  rmSync(join(DATA_DIR, "pdfs", `${docId}.pdf`), { force: true });

  // Explain mode: a drag-select creates an explanation highlight, which
  // eagerly fires POST /ai/explain.
  await page.locator('button[aria-label="Explain"]').click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-explain-active",
    "true",
  );

  const requestPromise = page.waitForRequest(
    (req) => req.url().includes("/ai/explain") && req.method() === "POST",
  );

  const runs = pageWrap.locator(".text-run");
  const count = await runs.count();
  let dragged = false;
  for (let i = 0; i < count; i++) {
    const box = await runs.nth(i).boundingBox();
    if (box && box.width > 40) {
      const midY = box.y + box.height / 2;
      await page.mouse.move(box.x + 2, midY);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 2, midY, { steps: 12 });
      await page.mouse.up();
      dragged = true;
      break;
    }
  }
  expect(dragged).toBe(true);

  const request = await requestPromise;
  const body = request.postDataJSON() as { page_text?: string };

  // The server's PDF is gone, yet the request still carries real, rendered
  // page content — grounding no longer depends on the ephemeral cache.
  expect(body.page_text).toBeTruthy();
  expect(body.page_text).toContain(sampleText!);
});
