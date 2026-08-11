import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// "Download PDF with highlights" round trip: a highlight + its AI explanation
// survive Download → (simulated) send-to-a-friend → Open in a fresh browser
// profile (a separate context = a separate IndexedDB, same server). This is
// the end-to-end proof for the feature: the friend never touched the
// original document, only the downloaded file.
//
// This suite runs against the built single-server app (playwright.app.config.ts
// serves `frontend/dist`, not Vite's dev server), so — unlike
// e2e-storage/explanationCache.persistence.spec.ts — there's no `/src/*.ts` to
// dynamically import from inside the page. Reads/writes to the app's
// IndexedDB store go through the raw `indexedDB` API instead, mirroring the
// schema in `src/storage/localStore.ts` (db "scai-reader", stores
// "documents"/"annotations"/"explanations"/"viewState").

const PDF_PATH = fileURLToPath(new URL("../../Animal_farm.pdf", import.meta.url));
const DB_NAME = "scai-reader";

/** Upload the PDF and wait for the first page's text layer to render. */
async function openPdf(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator("#file").setInputFiles(PDF_PATH);
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

/** The one document this profile's library knows about (id + filename). */
async function soleLocalDocId(page: Page, dbName: string): Promise<string> {
  return page.evaluate((name) => {
    return new Promise<string>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("documents", "readonly");
        const getAll = tx.objectStore("documents").getAll();
        getAll.onsuccess = () => resolve((getAll.result[0] as { id: string }).id);
        getAll.onerror = () => reject(getAll.error);
      };
    });
  }, dbName);
}

async function seedExplanation(
  page: Page,
  dbName: string,
  row: {
    docId: string;
    annotationId: string;
    kind: string;
    text: string;
    content: string;
    status: string;
    updated_at: string;
  },
): Promise<void> {
  await page.evaluate(
    ({ name, value }) => {
      return new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("explanations", "readwrite");
          tx.objectStore("explanations").put(value);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    { name: dbName, value: row },
  );
}

async function readExplanation(
  page: Page,
  dbName: string,
  docId: string,
  annotationId: string,
): Promise<{ content: string } | undefined> {
  return page.evaluate(
    ({ name, key }) => {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("explanations", "readonly");
          const get = tx.objectStore("explanations").get(key);
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => reject(get.error);
        };
      });
    },
    { name: dbName, key: [docId, annotationId] },
  ) as Promise<{ content: string } | undefined>;
}

test("a highlight + its explanation survive Download and Open in a fresh browser profile", async ({
  page,
  browser,
}) => {
  await openPdf(page);

  // Create a (yellow) highlight the ordinary way.
  await page.locator('button[aria-label="Highlight"]').click();
  await dragSelectFirstWideRun(page);
  const annotation = page.locator(".annotation-layer .annotation").first();
  await expect(annotation).toHaveCount(1);
  const annotationId = await annotation.getAttribute("data-annotation-id");
  expect(annotationId).toBeTruthy();

  // Seed a cached AI explanation for it directly (no live model in this
  // environment).
  const docId = await soleLocalDocId(page, DB_NAME);
  await seedExplanation(page, DB_NAME, {
    docId,
    annotationId: annotationId!,
    kind: "definition",
    text: "Napoleon",
    content: "The pig who seizes power on the farm.",
    status: "complete",
    updated_at: new Date(0).toISOString(),
  });

  // Download the annotated PDF.
  const downloadButton = page.locator(
    'button[aria-label="Download PDF with highlights"]',
  );
  await expect(downloadButton).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    downloadButton.click(),
  ]);
  const dir = mkdtempSync(join(tmpdir(), "scai-e2e-download-"));
  const downloadedPath = join(dir, "shared.pdf");
  await download.saveAs(downloadedPath);

  // A friend opens the downloaded file in a brand-new browser profile — a
  // fresh IndexedDB, nothing shared with the original session except the
  // (stateless) server.
  const friendContext = await browser.newContext();
  const friendPage = await friendContext.newPage();
  await friendPage.goto("/");
  await friendPage.locator("#file").setInputFiles(downloadedPath);
  await friendPage.locator(".text-run").first().waitFor({ state: "attached" });

  // The highlight reappears, same color, without the friend ever selecting it.
  const friendAnnotation = friendPage.locator(".annotation-layer .annotation").first();
  await expect(friendAnnotation).toHaveCount(1);
  await expect(friendAnnotation).toHaveAttribute("data-color", "yellow");
  const friendAnnotationId = await friendAnnotation.getAttribute("data-annotation-id");
  expect(friendAnnotationId).toBe(annotationId);

  // The explanation is in the friend's own local cache too (so hovering
  // shows it with zero AI calls), under whatever new doc id their upload
  // was assigned.
  const friendDocId = await soleLocalDocId(friendPage, DB_NAME);
  expect(friendDocId).not.toBe(docId); // a genuinely new upload, new sha256
  const friendExplanation = await readExplanation(
    friendPage,
    DB_NAME,
    friendDocId,
    annotationId!,
  );
  expect(friendExplanation?.content).toBe("The pig who seizes power on the farm.");

  await friendContext.close();
});
