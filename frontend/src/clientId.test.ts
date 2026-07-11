import { describe, it, expect, beforeEach, vi } from "vitest";

describe("getClientId", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("generates and persists an id on first call", async () => {
    const { getClientId } = await import("./clientId.ts");
    const id = getClientId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(localStorage.getItem("scai.clientId")).toBe(id);
  });

  it("returns the same id on repeated calls", async () => {
    const { getClientId } = await import("./clientId.ts");
    expect(getClientId()).toBe(getClientId());
  });

  it("picks up an id already in localStorage from a previous session", async () => {
    localStorage.setItem("scai.clientId", "existing-id-123");
    const { getClientId } = await import("./clientId.ts");
    expect(getClientId()).toBe("existing-id-123");
  });
});
