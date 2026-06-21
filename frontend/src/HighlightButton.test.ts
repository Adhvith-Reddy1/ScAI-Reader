import { describe, it, expect, beforeEach } from "vitest";
import { buildHighlightButton } from "./HighlightButton.ts";
import { getHighlightMode, _resetForTest } from "./highlightMode.ts";
import { PALETTES } from "./palettes.ts";

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

  it("opens popover with the current palette's swatches", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    open(root);
    expect((root.querySelector(".hl-popover") as HTMLDivElement).hidden).toBe(false);
    const shown = [...root.querySelectorAll(".hl-swatches .swatch")].map(
      (el) => (el as HTMLElement).dataset.color,
    );
    expect(shown).toEqual(PALETTES[0].colors);
  });

  it("picking a swatch activates cosmetic mode and persists the color", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    open(root);
    const pick = PALETTES[0].colors[2];
    (root.querySelector(`[data-color="${pick}"]`) as HTMLButtonElement).click();
    const s = getHighlightMode();
    expect(s.active).toBe(true);
    expect(s.explain).toBe(false);
    expect(s.color).toBe(pick);
    expect(localStorage.getItem("scai.highlightPrefs")).toContain(pick);
  });

  it("the ⋮ menu switches palettes and swaps the swatches", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    open(root);
    (root.querySelector(".hl-palette-menu") as HTMLButtonElement).click();
    const second = PALETTES[1];
    (root.querySelector(`[data-palette="${second.id}"]`) as HTMLButtonElement).click();
    const shown = [...root.querySelectorAll(".hl-swatches .swatch")].map(
      (el) => (el as HTMLElement).dataset.color,
    );
    expect(shown).toEqual(second.colors);
  });

  it("Off deactivates; clicking button while active toggles off", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    open(root);
    (root.querySelector(".swatch") as HTMLButtonElement).click();
    expect(getHighlightMode().active).toBe(true);

    const button = root.querySelector(".hl-button") as HTMLButtonElement;
    button.click(); // active cosmetic → toggles off
    expect(getHighlightMode().active).toBe(false);
    expect((root.querySelector(".hl-popover") as HTMLDivElement).hidden).toBe(true);
  });
});
