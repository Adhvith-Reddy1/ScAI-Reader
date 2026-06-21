import { describe, it, expect, beforeEach } from "vitest";
import { buildHighlightButton } from "./HighlightButton.ts";
import { getHighlightMode, _resetForTest } from "./highlightMode.ts";
import { PALETTES, EXPLAIN_COLOR } from "./palettes.ts";

function open(root: HTMLElement): void {
  (root.querySelector(".hl-button") as HTMLButtonElement).click();
}

describe("HighlightButton", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    _resetForTest();
  });

  it("renders button + hidden popover", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    expect(root.querySelector(".hl-button")).not.toBeNull();
    expect((root.querySelector(".hl-popover") as HTMLDivElement).hidden).toBe(true);
  });

  it("opens popover on button click, with a tab per palette", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    open(root);
    expect((root.querySelector(".hl-popover") as HTMLDivElement).hidden).toBe(false);
    expect(root.querySelectorAll(".hl-palette-tab").length).toBe(PALETTES.length);
  });

  it("picking a swatch activates cosmetic mode with that color", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    open(root);
    const first = PALETTES[0].colors[0];
    (root.querySelector(`[data-color="${first}"]`) as HTMLButtonElement).click();
    const s = getHighlightMode();
    expect(s.active).toBe(true);
    expect(s.explain).toBe(false);
    expect(s.color).toBe(first);
  });

  it("switching palette swaps the swatch set", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    open(root);
    const second = PALETTES[1];
    (root.querySelector(`[data-palette="${second.id}"]`) as HTMLButtonElement).click();
    const shown = [...root.querySelectorAll(".hl-swatches .swatch")].map(
      (el) => (el as HTMLElement).dataset.color,
    );
    expect(shown).toEqual(second.colors);
  });

  it("Explain button activates the AI explain highlight", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    open(root);
    (root.querySelector(".hl-explain") as HTMLButtonElement).click();
    const s = getHighlightMode();
    expect(s.active).toBe(true);
    expect(s.explain).toBe(true);
    expect(s.color).toBe(EXPLAIN_COLOR);
  });

  it("Off button deactivates", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    open(root);
    (root.querySelector(".swatch") as HTMLButtonElement).click();
    expect(getHighlightMode().active).toBe(true);
    open(root);
    (root.querySelector(".hl-off") as HTMLButtonElement).click();
    expect(getHighlightMode().active).toBe(false);
  });

  it("remembers the picked color as the persisted default", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    open(root);
    const pick = PALETTES[0].colors[2];
    (root.querySelector(`[data-color="${pick}"]`) as HTMLButtonElement).click();
    // A freshly built button reflects the persisted color in its indicator.
    _resetForTest();
    const root2 = buildHighlightButton();
    const indicator = root2.querySelector(".hl-indicator") as HTMLElement;
    // jsdom normalizes the hex to rgb(); just assert it's set (non-empty).
    expect(indicator.style.background).not.toBe("");
    expect(localStorage.getItem("scai.highlightPrefs")).toContain(pick);
  });

  it("clicking button while active toggles off without opening popover", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    const button = root.querySelector(".hl-button") as HTMLButtonElement;
    open(root);
    (root.querySelector(".swatch") as HTMLButtonElement).click();
    expect(getHighlightMode().active).toBe(true);
    button.click();
    expect(getHighlightMode().active).toBe(false);
    expect((root.querySelector(".hl-popover") as HTMLDivElement).hidden).toBe(true);
  });
});
