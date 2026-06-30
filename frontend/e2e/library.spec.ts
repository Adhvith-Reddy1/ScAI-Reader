import { test, expect } from "@playwright/test";
import path from "node:path";

// Spec 04: the library lives in the browser. This drives the real
// single-server app (backend renders; IndexedDB stores) and proves the central
// claims that only a real browser can show: an uploaded PDF survives a reload,
// reopens (re-supplying its bytes to the server), and deletes cleanly.
//
// Playwright gives each test a fresh context, so IndexedDB starts empty.

const PDF = path.resolve(process.cwd(), "..", "Animal_farm.pdf");

test("upload persists across reload, reopens from storage, and deletes", async ({
  page,
}) => {
  await page.goto("/");

  // --- Upload: stored in IndexedDB + rendered by the server.
  await page.locator("#file").setInputFiles(PDF);
  await expect(page.locator(".page-list")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#doc-info")).toContainText("Animal_farm.pdf");

  // --- Reload: the library lists the stored doc (IndexedDB persistence).
  await page.reload();
  const tile = page.locator(".library-tile", { hasText: "Animal" });
  await expect(tile).toBeVisible();

  // --- Reopen: re-supplies the stored bytes to the server and renders again.
  await tile.locator(".library-tile-open").click();
  await expect(page.locator(".page-list")).toBeVisible({ timeout: 30_000 });

  // --- Delete from the library, then confirm it's gone after a reload.
  await page.reload();
  await expect(page.locator(".library-tile")).toBeVisible();
  await page.locator(".library-tile-delete").first().click();
  await expect(page.locator(".library-tile")).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".library-empty")).toContainText("No documents");
});
