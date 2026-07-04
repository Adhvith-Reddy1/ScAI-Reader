import { expect, test } from "@playwright/test";

// Proves the export control is wired into the real toolbar (not just that
// share.ts works): on the landing page there's no open document, so the button
// must render and be disabled. The landing page loads from IndexedDB only, so
// no backend is needed.

test("Save-with-notes button renders in the toolbar, disabled until a doc is open", async ({
  page,
}) => {
  await page.goto("/");
  const btn = page.getByRole("button", { name: "Save PDF with annotations" });
  await expect(btn).toBeVisible();
  await expect(btn).toBeDisabled();
  await expect(btn).toContainText("Save with notes");
});
