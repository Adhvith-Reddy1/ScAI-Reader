import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Full-app E2E (Spec 05 highlights). Kept separate from the default
// `playwright.config.ts` (smoke) on purpose: these tests UPLOAD a PDF, which
// gives the server a document. The smoke test asserts an *empty* server
// library, so the two must not share a backend. Here we run a dedicated server
// on its own port with a throwaway data dir, so uploading never pollutes the
// smoke run — and each run starts from a clean library.
//
// Run with: npx playwright test --config playwright.app.config.ts

const PORT = process.env.E2E_APP_PORT ?? "8100";
const BASE_URL = `http://127.0.0.1:${PORT}`;

const CHROMIUM_PATH =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";

// Fresh, isolated backend storage for this run only. Exported so specs that
// need to reach into the server's on-disk state (e.g. simulating an evicted
// ephemeral PDF cache) know where to look.
export const DATA_DIR = mkdtempSync(join(tmpdir(), "scai-e2e-app-"));

export default defineConfig({
  testDir: "./e2e-app",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // All specs here share ONE backend process and on-disk data dir (see
  // webServer below). Some tests mutate that shared server-side state
  // directly (e.g. deleting the cached PDF file to simulate an ephemeral-cache
  // eviction) — running them in parallel workers races against whatever else
  // is touching the same file/server at that moment. Keep this suite serial.
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    launchOptions: { executablePath: CHROMIUM_PATH },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command:
      "bash -c 'cd ../backend && PDF_READER_DATA_DIR=" +
      DATA_DIR +
      " .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port " +
      PORT +
      "'",
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
