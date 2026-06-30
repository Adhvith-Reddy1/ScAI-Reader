/// <reference types="vitest" />
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/documents": "http://localhost:8000",
      "/healthz": "http://localhost:8000",
      "/settings": "http://localhost:8000",
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    // Playwright owns `e2e/` (run via `npx playwright test`); Vitest must not
    // try to collect those specs — its `test()` is not Playwright's.
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
