import { describe, it, expect, beforeEach } from "vitest";
import { buildExplainButton } from "./ExplainButton.ts";
import { getHighlightMode, _resetForTest } from "./highlightMode.ts";
import { PALETTES, saveHighlightPrefs } from "./palettes.ts";

function open(root: HTMLElement): void {
  (root.querySelector(".explain-button") as HTMLButtonElement).click();
}

describe("ExplainButton", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    _resetForTest();
  });

  it("opens a popover with the current palette's swatches", () => {
    saveHighlightPrefs({ paletteId: PALETTES[2].id });
    const root = buildExplainButton();
    document.body.appendChild(root);
    open(root);
    const shown = [...root.querySelectorAll(".swatch")].map(
      (el) => (el as HTMLElement).dataset.color,
    );
    expect(shown).toEqual(PALETTES[2].colors);
  });

  it("picking a color turns on an Explain highlight in that color", () => {
    const root = buildExplainButton();
    document.body.appendChild(root);
    open(root);
    const pick = PALETTES[0].colors[3];
    (root.querySelector(`[data-color="${pick}"]`) as HTMLButtonElement).click();
    const s = getHighlightMode();
    expect(s.active).toBe(true);
    expect(s.explain).toBe(true);
    expect(s.color).toBe(pick);
    expect(localStorage.getItem("scai.highlightPrefs")).toContain(pick);
  });

  it("clicking the button while explain-active toggles it off", () => {
    const root = buildExplainButton();
    document.body.appendChild(root);
    open(root);
    (root.querySelector(".swatch") as HTMLButtonElement).click();
    expect(getHighlightMode().explain).toBe(true);

    (root.querySelector(".explain-button") as HTMLButtonElement).click();
    expect(getHighlightMode().active).toBe(false);
  });
});
