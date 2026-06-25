import { describe, it, expect, beforeEach } from "vitest";
import { buildHighlightButton } from "./HighlightButton.ts";
import { getHighlightMode, _resetForTest } from "./highlightMode.ts";

describe("HighlightButton (split button)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    _resetForTest();
  });

  it("renders the button group + caret + hidden popover", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    expect(root.querySelector(".hl-button")).not.toBeNull();
    expect(root.querySelector(".hl-caret")).not.toBeNull();
    expect((root.querySelector(".hl-popover") as HTMLDivElement).hidden).toBe(true);
  });

  it("main button activates with the current color, without opening popover", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    (root.querySelector(".hl-button") as HTMLButtonElement).click();
    expect(getHighlightMode()).toEqual({ active: true, color: "yellow" });
    expect((root.querySelector(".hl-popover") as HTMLDivElement).hidden).toBe(true);
  });

  it("main button toggles off on a second click (color retained)", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    const button = root.querySelector(".hl-button") as HTMLButtonElement;
    button.click();
    expect(getHighlightMode().active).toBe(true);
    button.click();
    expect(getHighlightMode()).toEqual({ active: false, color: "yellow" });
  });

  it("caret opens the color popover", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    (root.querySelector(".hl-caret") as HTMLButtonElement).click();
    expect((root.querySelector(".hl-popover") as HTMLDivElement).hidden).toBe(false);
  });

  it("picking a swatch sets color and activates", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    (root.querySelector(".hl-caret") as HTMLButtonElement).click();
    (root.querySelector('.hl-popover [data-color="red"]') as HTMLButtonElement).click();
    expect(getHighlightMode()).toEqual({ active: true, color: "red" });
    expect((root.querySelector(".hl-popover") as HTMLDivElement).hidden).toBe(true);
  });

  it("after choosing a color, the main button reactivates that color", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    const button = root.querySelector(".hl-button") as HTMLButtonElement;
    (root.querySelector(".hl-caret") as HTMLButtonElement).click();
    (root.querySelector('.hl-popover [data-color="green"]') as HTMLButtonElement).click();
    button.click(); // toggle off
    expect(getHighlightMode().active).toBe(false);
    button.click(); // toggle back on — should keep green
    expect(getHighlightMode()).toEqual({ active: true, color: "green" });
  });

  it("button reflects active state via data attrs", () => {
    const root = buildHighlightButton();
    document.body.appendChild(root);
    const button = root.querySelector(".hl-button") as HTMLButtonElement;
    (root.querySelector(".hl-caret") as HTMLButtonElement).click();
    (root.querySelector('.hl-popover [data-color="pink"]') as HTMLButtonElement).click();
    expect(button.dataset.active).toBe("true");
    expect(button.dataset.color).toBe("pink");
  });
});
