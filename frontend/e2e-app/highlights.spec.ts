import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// Spec 05: highlights are created/listed/deleted in IndexedDB only — no
// network. The proof that matters can only be shown in a real browser: a
// dragged highlight must survive a full page reload, and erasing it must
// survive a reload too. (Vitest covers the store shape; this covers the real
// drag-select + reload durability.)

// A real text PDF that lives in the repo root (two levels up from e2e/).
const PDF_PATH = fileURLToPath(new URL("../../Animal_farm.pdf", import.meta.url));

const annotations = (page: Page) =>
  page.locator(".annotation-layer .annotation");

/** Upload the PDF and wait for the first page's text layer to render. */
async function openPdf(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator("#file").setInputFiles(PDF_PATH);
  await page.locator(".text-run").first().waitFor({ state: "attached" });
}

/** Re-open the (already-uploaded) doc from the library after a reload. */
async function reopenFromLibrary(page: Page): Promise<void> {
  await page.reload();
  await page.locator(".library-tile").first().click();
  await page.locator(".text-run").first().waitFor({ state: "attached" });
}

/** Drag-select across a usefully-wide text run to create a highlight. */
async function dragSelectFirstWideRun(page: Page): Promise<void> {
  const runs = page.locator(".text-run");
  const count = await runs.count();
  for (let i = 0; i < count; i++) {
    const box = await runs.nth(i).boundingBox();
    if (box && box.width > 40) {
      const midY = box.y + box.height / 2;
      await page.mouse.move(box.x + 2, midY);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 2, midY, { steps: 12 });
      await page.mouse.up();
      return;
    }
  }
  throw new Error("no wide enough text run found to drag-select");
}

test("a dragged highlight persists across reload; erasing it persists too", async ({
  page,
}) => {
  // Fail loudly if any highlight CRUD sneaks onto the network — Spec 05 says it
  // must not. (Page render/text/figure GETs are fine; annotation writes are not.)
  page.on("request", (req) => {
    const url = req.url();
    if (/\/annotations(\b|\/|\?)/.test(url) && req.method() !== "GET") {
      throw new Error(`unexpected annotation network ${req.method()} ${url}`);
    }
  });

  await openPdf(page);

  // Activate the Highlight tool, then drag to create a highlight.
  await page.locator('button[aria-label="Highlight"]').click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-highlight-active",
    "true",
  );
  await dragSelectFirstWideRun(page);
  await expect(annotations(page)).toHaveCount(1);

  // Reload + re-open: the highlight must come back from IndexedDB.
  await reopenFromLibrary(page);
  await expect(annotations(page)).toHaveCount(1);

  // Erase it, then prove the deletion is durable across another reload.
  await page.locator('button[aria-label="Erase highlights"]').click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-erase-active",
    "true",
  );
  await annotations(page).first().click();
  await expect(annotations(page)).toHaveCount(0);

  await reopenFromLibrary(page);
  await expect(annotations(page)).toHaveCount(0);
});
