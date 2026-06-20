import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getEraseMode,
  setEraseMode,
  toggleEraseMode,
  subscribeEraseMode,
  _resetForTest as _resetEraseForTest,
} from "./eraseMode.ts";
import {
  getHighlightMode,
  setHighlightMode,
  _resetForTest as _resetHighlightForTest,
} from "./highlightMode.ts";

describe("erase mode state", () => {
  beforeEach(() => {
    _resetHighlightForTest();
    _resetEraseForTest();
  });

  it("starts inactive", () => {
    expect(getEraseMode().active).toBe(false);
  });

  it("setEraseMode merges partial updates", () => {
    setEraseMode({ active: true });
    expect(getEraseMode()).toEqual({ active: true });
    setEraseMode({ active: false });
    expect(getEraseMode()).toEqual({ active: false });
  });

  it("toggleEraseMode flips active", () => {
    toggleEraseMode();
    expect(getEraseMode().active).toBe(true);
    toggleEraseMode();
    expect(getEraseMode().active).toBe(false);
  });

  it("subscribers fire immediately and on change", () => {
    const cb = vi.fn();
    subscribeEraseMode(cb);
    expect(cb).toHaveBeenCalledTimes(1);
    setEraseMode({ active: true });
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1][0]).toEqual({ active: true });
  });

  it("unsubscribe stops callbacks", () => {
    const cb = vi.fn();
    const off = subscribeEraseMode(cb);
    off();
    setEraseMode({ active: true });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("turning on erase turns off highlight mode", () => {
    setHighlightMode({ active: true, color: "red" });
    expect(getHighlightMode().active).toBe(true);
    setEraseMode({ active: true });
    expect(getHighlightMode().active).toBe(false);
    expect(getEraseMode().active).toBe(true);
  });

  it("turning on highlight turns off erase mode", () => {
    setEraseMode({ active: true });
    expect(getEraseMode().active).toBe(true);
    setHighlightMode({ active: true });
    expect(getEraseMode().active).toBe(false);
    expect(getHighlightMode().active).toBe(true);
  });
});
