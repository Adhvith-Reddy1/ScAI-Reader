import { describe, it, expect, beforeEach } from "vitest";
import { clearUserApiKey, getUserApiKey, setUserApiKey } from "./userApiKey.ts";

describe("userApiKey", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when no key has been set", () => {
    expect(getUserApiKey()).toBeNull();
  });

  it("stores and retrieves a key, trimmed", () => {
    setUserApiKey("  sk-personal-test  ");
    expect(getUserApiKey()).toBe("sk-personal-test");
  });

  it("clears the stored key", () => {
    setUserApiKey("sk-personal-test");
    clearUserApiKey();
    expect(getUserApiKey()).toBeNull();
  });
});
