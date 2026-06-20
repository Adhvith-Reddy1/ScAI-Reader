/// <reference types="vitest" />
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/documents": "http://localhost:8000",
      "/healthz": "http://localhost:8000",
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
  },
});
