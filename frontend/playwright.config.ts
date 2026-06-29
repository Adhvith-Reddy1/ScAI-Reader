import { defineConfig, devices } from "@playwright/test";

// Port the app under test listens on. The single-server mode (run.sh) serves
// both the API and the built SPA from here, so E2E can hit one origin.
const PORT = process.env.E2E_PORT ?? "8000";
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Chromium is preinstalled in the managed environment; point Playwright at it
// instead of downloading a matching build (PLAYWRIGHT_BROWSERS_PATH is set).
const CHROMIUM_PATH =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    launchOptions: { executablePath: CHROMIUM_PATH },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Build + serve the single-server app for the tests. Reuses an already
  // running server (e.g. one started by hand) so local iteration is fast.
  webServer: {
    command:
      "bash -c 'cd ../backend && .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port " +
      PORT +
      "'",
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
