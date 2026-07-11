import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// Trackpad pinch-zoom must keep the content under the cursor fixed on
// screen as zoom changes. Regression coverage for a real bug: anchoring by
// "fraction of the viewer's total scrollWidth/scrollHeight" mixes in
// non-scaling content (viewer padding, inter-page gaps), so the anchor
// drifted further off the cursor with every zoom tick — worse on a short
// document, where that non-scaling content is a bigger share of the total.
// The fix anchors against the actual page element under the cursor instead,
// which scales uniformly with zoom.

const PDF_PATH = fileURLToPath(new URL("../../Animal_farm.pdf", import.meta.url));

async function openPdf(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator("#file").setInputFiles(PDF_PATH);
  await page.locator(".text-run").first().waitFor({ state: "attached" });
}

test("pinch-zoom keeps the content under the cursor fixed on screen", async ({
  page,
}) => {
  await openPdf(page);
  await page.waitForTimeout(300); // let layout fully settle before anchoring

  const target = page.locator(".text-run").first();
  const startBox = await target.boundingBox();
  if (!startBox) throw new Error("no text-run box");
  const cursorX = startBox.x + startBox.width / 2;
  const cursorY = startBox.y + startBox.height / 2;

  await page.mouse.move(cursorX, cursorY);
  await page.keyboard.down("Control");
  try {
    for (let tick = 0; tick < 4; tick++) {
      await page.mouse.wheel(0, -60); // negative deltaY = pinch in / zoom in
      // Let the rAF-throttled zoom apply and layout settle.
      await page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
      const box = await target.boundingBox();
      expect(box).not.toBeNull();
      if (!box) continue;
      const dx = box.x + box.width / 2 - cursorX;
      const dy = box.y + box.height / 2 - cursorY;
      // A few CSS pixels of tolerance for text-layer relayout/DPI-bucket
      // rounding — the pre-fix drift was tens to ~100px and grew every tick
      // (the whole point of this test is that it does NOT grow here).
      expect(Math.abs(dx)).toBeLessThan(10);
      expect(Math.abs(dy)).toBeLessThan(10);
    }
  } finally {
    await page.keyboard.up("Control");
  }
});
