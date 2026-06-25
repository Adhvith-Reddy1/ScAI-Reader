import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getExplainMode,
  setExplainMode,
  toggleExplainMode,
  subscribeExplainMode,
  _resetForTest as _resetExplain,
} from "./explainMode.ts";
import {
  getHighlightMode,
  setHighlightMode,
  _resetForTest as _resetHighlight,
} from "./highlightMode.ts";
import {
  getEraseMode,
  setEraseMode,
  _resetForTest as _resetErase,
} from "./eraseMode.ts";

describe("explain mode state", () => {
  beforeEach(() => {
    _resetHighlight();
    _resetErase();
    _resetExplain();
  });

  it("starts inactive with blue as default color", () => {
    expect(getExplainMode()).toEqual({ active: false, color: "blue" });
  });

  it("setExplainMode merges partial updates", () => {
    setExplainMode({ color: "green" });
    expect(getExplainMode()).toEqual({ active: false, color: "green" });
    setExplainMode({ active: true });
    expect(getExplainMode()).toEqual({ active: true, color: "green" });
  });

  it("toggleExplainMode flips active", () => {
    toggleExplainMode();
    expect(getExplainMode().active).toBe(true);
    toggleExplainMode();
    expect(getExplainMode().active).toBe(false);
  });

  it("subscribers fire immediately and on change", () => {
    const cb = vi.fn();
    subscribeExplainMode(cb);
    expect(cb).toHaveBeenCalledTimes(1);
    setExplainMode({ color: "pink" });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("turning on explain turns off highlight and erase", () => {
    setHighlightMode({ active: true, color: "yellow" });
    setEraseMode({ active: true }); // this already turns highlight off
    setExplainMode({ active: true, color: "red" });
    expect(getExplainMode().active).toBe(true);
    expect(getHighlightMode().active).toBe(false);
    expect(getEraseMode().active).toBe(false);
  });

  it("turning on highlight turns off explain", () => {
    setExplainMode({ active: true });
    expect(getExplainMode().active).toBe(true);
    setHighlightMode({ active: true });
    expect(getExplainMode().active).toBe(false);
    expect(getHighlightMode().active).toBe(true);
  });

  it("turning on erase turns off explain", () => {
    setExplainMode({ active: true });
    setEraseMode({ active: true });
    expect(getExplainMode().active).toBe(false);
    expect(getEraseMode().active).toBe(true);
  });
});
