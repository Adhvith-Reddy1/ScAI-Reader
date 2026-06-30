import { defineConfig, devices } from "@playwright/test";

// Standalone Playwright config for the browser-storage foundation (Spec 02).
//
// Spec 02 wires nothing into the UI, so the backend-based smoke config can't
// reach the storage module. This config serves the frontend with Vite alone
// (no backend) and drives `src/storage/localStore.ts` directly in a real
// Chromium — the only way to prove IndexedDB persistence across a reload, which
// jsdom/fake-indexeddb cannot.
const PORT = process.env.STORAGE_E2E_PORT ?? "5174";
const BASE_URL = `http://127.0.0.1:${PORT}`;

const CHROMIUM_PATH =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: "./e2e-storage",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    launchOptions: { executablePath: CHROMIUM_PATH },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
