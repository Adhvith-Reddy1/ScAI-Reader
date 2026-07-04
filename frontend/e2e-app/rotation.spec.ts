import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// Rotation is a real-browser feature: the page content is spun with a CSS
// transform, the scroll footprint is reserved rotated, and (the tricky part)
// text selection while rotated must still land a correctly-placed highlight.
// The pure geometry is unit-tested; this proves the end-to-end wiring.

const PDF_PATH = fileURLToPath(new URL("../../Animal_farm.pdf", import.meta.url));

const firstContent = (page: Page) => page.locator(".page-content").first();
const firstWrap = (page: Page) => page.locator(".page-wrap").first();
const annotations = (page: Page) =>
  page.locator(".annotation-layer .annotation");

async function openPdf(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator("#file").setInputFiles(PDF_PATH);
  await page.locator(".text-run").first().waitFor({ state: "attached" });
}

async function reopenFromLibrary(page: Page): Promise<void> {
  await page.reload();
  await page.locator(".library-tile").first().click();
  await page.locator(".text-run").first().waitFor({ state: "attached" });
}

async function aspect(page: Page): Promise<number> {
  const box = await firstWrap(page).boundingBox();
  if (!box) throw new Error("no page-wrap box");
  return box.width / box.height;
}

test("rotate right spins the page 90°, flips its aspect, and persists across reload", async ({
  page,
}) => {
  await openPdf(page);

  // Animal_farm is portrait: taller than wide.
  expect(await aspect(page)).toBeLessThan(1);
  await expect(firstContent(page)).toHaveAttribute("style", /rotate\(0deg\)/);

  await page.locator('button[aria-label="Rotate right"]').click();

  // Content carries a 90° transform and the reserved footprint is now landscape.
  await expect(firstContent(page)).toHaveAttribute("style", /rotate\(90deg\)/);
  await expect
    .poll(async () => aspect(page), { timeout: 5000 })
    .toBeGreaterThan(1);

  // Rotation is part of the saved place: it comes back after a reload + reopen.
  await reopenFromLibrary(page);
  await expect(firstContent(page)).toHaveAttribute("style", /rotate\(90deg\)/);
  expect(await aspect(page)).toBeGreaterThan(1);
});

test("rotate left from upright wraps to 270°", async ({ page }) => {
  await openPdf(page);
  await page.locator('button[aria-label="Rotate left"]').click();
  await expect(firstContent(page)).toHaveAttribute("style", /rotate\(270deg\)/);
});

test("a highlight created while rotated is saved and survives reload", async ({
  page,
}) => {
  await openPdf(page);
  await page.locator('button[aria-label="Rotate right"]').click();
  await expect(firstContent(page)).toHaveAttribute("style", /rotate\(90deg\)/);

  // Activate the Highlight tool and drag across a text run. The run is visually
  // rotated, so drag corner-to-corner of its (screen-space) box to be
  // orientation-agnostic.
  await page.locator('button[aria-label="Highlight"]').click();
  const runs = page.locator(".text-run");
  const count = await runs.count();
  let dragged = false;
  for (let i = 0; i < count; i++) {
    const box = await runs.nth(i).boundingBox();
    if (box && box.width * box.height > 300) {
      await page.mouse.move(box.x + 2, box.y + 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 2, box.y + box.height - 2, {
        steps: 12,
      });
      await page.mouse.up();
      dragged = true;
      break;
    }
  }
  expect(dragged).toBe(true);

  // The highlight renders (inside the rotated content layer)…
  await expect(annotations(page)).toHaveCount(1);

  // …and it was persisted to IndexedDB in canonical page space, so it comes
  // back after a reload + reopen (still rotated).
  await reopenFromLibrary(page);
  await expect(firstContent(page)).toHaveAttribute("style", /rotate\(90deg\)/);
  await expect(annotations(page)).toHaveCount(1);
});
