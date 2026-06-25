import { describe, it, expect, beforeEach } from "vitest";
import { buildExplainButton } from "./ExplainButton.ts";
import { getExplainMode, _resetForTest } from "./explainMode.ts";

describe("ExplainButton (split button)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    _resetForTest();
  });

  it("renders the button group + caret + hidden popover", () => {
    const root = buildExplainButton();
    document.body.appendChild(root);
    expect(root.querySelector(".explain-button")).not.toBeNull();
    expect(root.querySelector(".explain-caret")).not.toBeNull();
    expect(
      (root.querySelector(".explain-popover") as HTMLDivElement).hidden,
    ).toBe(true);
  });

  it("main button activates with the current color, without opening popover", () => {
    const root = buildExplainButton();
    document.body.appendChild(root);
    (root.querySelector(".explain-button") as HTMLButtonElement).click();
    expect(getExplainMode()).toEqual({ active: true, color: "blue" });
    expect(
      (root.querySelector(".explain-popover") as HTMLDivElement).hidden,
    ).toBe(true);
  });

  it("main button toggles off on a second click (color retained)", () => {
    const root = buildExplainButton();
    document.body.appendChild(root);
    const button = root.querySelector(".explain-button") as HTMLButtonElement;
    button.click();
    expect(getExplainMode().active).toBe(true);
    button.click();
    expect(getExplainMode()).toEqual({ active: false, color: "blue" });
  });

  it("caret opens the color popover", () => {
    const root = buildExplainButton();
    document.body.appendChild(root);
    (root.querySelector(".explain-caret") as HTMLButtonElement).click();
    expect(
      (root.querySelector(".explain-popover") as HTMLDivElement).hidden,
    ).toBe(false);
  });

  it("picking a swatch sets color and activates", () => {
    const root = buildExplainButton();
    document.body.appendChild(root);
    (root.querySelector(".explain-caret") as HTMLButtonElement).click();
    (root.querySelector('.explain-popover [data-color="green"]') as HTMLButtonElement).click();
    expect(getExplainMode()).toEqual({ active: true, color: "green" });
    expect(
      (root.querySelector(".explain-popover") as HTMLDivElement).hidden,
    ).toBe(true);
  });

  it("after choosing a color, the main button reactivates that color", () => {
    const root = buildExplainButton();
    document.body.appendChild(root);
    const button = root.querySelector(".explain-button") as HTMLButtonElement;
    (root.querySelector(".explain-caret") as HTMLButtonElement).click();
    (root.querySelector('.explain-popover [data-color="red"]') as HTMLButtonElement).click();
    button.click(); // off
    expect(getExplainMode().active).toBe(false);
    button.click(); // on again — keeps red
    expect(getExplainMode()).toEqual({ active: true, color: "red" });
  });

  it("button reflects active state via data attrs", () => {
    const root = buildExplainButton();
    document.body.appendChild(root);
    const button = root.querySelector(".explain-button") as HTMLButtonElement;
    (root.querySelector(".explain-caret") as HTMLButtonElement).click();
    (root.querySelector('.explain-popover [data-color="pink"]') as HTMLButtonElement).click();
    expect(button.dataset.active).toBe("true");
    expect(button.dataset.color).toBe("pink");
  });
});
