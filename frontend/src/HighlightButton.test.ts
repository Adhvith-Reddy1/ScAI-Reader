import { describe, it, expect, beforeEach } from "vitest";
import { buildHighlightButton } from "./HighlightButton.ts";
import {
  getHighlightMode,
  _resetForTest,
} from "./highlightMode.ts";

describe("HighlightButton", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    _resetForTest();
  });

  it("renders button + hidden popover", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    const button = root.querySelector(".hl-button") as HTMLButtonElement;
    const pop = root.querySelector(".hl-popover") as HTMLDivElement;
    expect(button).not.toBeNull();
    expect(pop.hidden).toBe(true);
  });

  it("opens popover on button click", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    (root.querySelector(".hl-button") as HTMLButtonElement).click();
    const pop = root.querySelector(".hl-popover") as HTMLDivElement;
    expect(pop.hidden).toBe(false);
  });

  it("picking a swatch activates mode with that color", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    (root.querySelector(".hl-button") as HTMLButtonElement).click();
    (root.querySelector('[data-color="red"]') as HTMLButtonElement).click();
    const state = getHighlightMode();
    expect(state.active).toBe(true);
    expect(state.color).toBe("red");
  });

  it("Off button deactivates", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    (root.querySelector(".hl-button") as HTMLButtonElement).click();
    (root.querySelector('[data-color="blue"]') as HTMLButtonElement).click();
    expect(getHighlightMode().active).toBe(true);

    (root.querySelector(".hl-button") as HTMLButtonElement).click(); // open
    (root.querySelector(".hl-off") as HTMLButtonElement).click();
    expect(getHighlightMode().active).toBe(false);
  });

  it("button reflects active state via data attrs", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    const button = root.querySelector(".hl-button") as HTMLButtonElement;
    button.click();
    (root.querySelector('[data-color="green"]') as HTMLButtonElement).click();
    expect(button.dataset.active).toBe("true");
    expect(button.dataset.color).toBe("green");
  });

  it("clicking button while active toggles off without opening popover", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    const button = root.querySelector(".hl-button") as HTMLButtonElement;
    button.click();
    (root.querySelector('[data-color="pink"]') as HTMLButtonElement).click();
    expect(getHighlightMode().active).toBe(true);

    button.click();
    expect(getHighlightMode().active).toBe(false);
    expect((root.querySelector(".hl-popover") as HTMLDivElement).hidden).toBe(true);
  });
});
