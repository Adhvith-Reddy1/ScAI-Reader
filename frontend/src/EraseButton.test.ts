import { describe, it, expect, beforeEach } from "vitest";
import { buildEraseButton } from "./EraseButton.ts";
import {
  getEraseMode,
  setEraseMode,
  _resetForTest as _resetEraseForTest,
} from "./eraseMode.ts";
import {
  setHighlightMode,
  _resetForTest as _resetHighlightForTest,
} from "./highlightMode.ts";

describe("EraseButton", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    _resetHighlightForTest();
    _resetEraseForTest();
  });

  it("renders a button labelled Erase", () => {
    const btn = buildEraseButton() as HTMLButtonElement;
    document.body.appendChild(btn);
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.textContent).toContain("Erase");
    expect(btn.dataset.active).toBe("false");
  });

  it("click toggles erase mode on and off", () => {
    const btn = buildEraseButton() as HTMLButtonElement;
    document.body.appendChild(btn);
    btn.click();
    expect(getEraseMode().active).toBe(true);
    expect(btn.dataset.active).toBe("true");
    btn.click();
    expect(getEraseMode().active).toBe(false);
    expect(btn.dataset.active).toBe("false");
  });

  it("reflects external state changes", () => {
    const btn = buildEraseButton() as HTMLButtonElement;
    document.body.appendChild(btn);
    setEraseMode({ active: true });
    expect(btn.dataset.active).toBe("true");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("gets deselected when highlight mode turns on", () => {
    const btn = buildEraseButton() as HTMLButtonElement;
    document.body.appendChild(btn);
    btn.click();
    expect(btn.dataset.active).toBe("true");
    setHighlightMode({ active: true });
    expect(getEraseMode().active).toBe(false);
    expect(btn.dataset.active).toBe("false");
  });

  it("aria-pressed mirrors the active state", () => {
    const btn = buildEraseButton() as HTMLButtonElement;
    document.body.appendChild(btn);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    btn.click();
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });
});
