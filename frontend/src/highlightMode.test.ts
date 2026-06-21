import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getHighlightMode,
  setHighlightMode,
  toggleHighlightMode,
  subscribeHighlightMode,
  _resetForTest,
} from "./highlightMode.ts";

describe("highlight mode state", () => {
  beforeEach(() => _resetForTest());

  it("starts inactive with yellow as default color", () => {
    const s = getHighlightMode();
    expect(s.active).toBe(false);
    expect(s.color).toBe("yellow");
  });

  it("setHighlightMode merges partial updates", () => {
    setHighlightMode({ color: "blue" });
    expect(getHighlightMode()).toEqual({
      active: false,
      color: "blue",
      explain: false,
    });
    setHighlightMode({ active: true });
    expect(getHighlightMode()).toEqual({
      active: true,
      color: "blue",
      explain: false,
    });
  });

  it("toggleHighlightMode flips active", () => {
    toggleHighlightMode();
    expect(getHighlightMode().active).toBe(true);
    toggleHighlightMode();
    expect(getHighlightMode().active).toBe(false);
  });

  it("subscribers fire immediately and on change", () => {
    const cb = vi.fn();
    subscribeHighlightMode(cb);
    expect(cb).toHaveBeenCalledTimes(1);
    setHighlightMode({ color: "red" });
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1][0]).toEqual({
      active: false,
      color: "red",
      explain: false,
    });
  });

  it("unsubscribe stops callbacks", () => {
    const cb = vi.fn();
    const off = subscribeHighlightMode(cb);
    off();
    setHighlightMode({ color: "green" });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
