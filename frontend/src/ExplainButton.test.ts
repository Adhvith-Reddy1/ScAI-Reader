import { describe, it, expect, beforeEach } from "vitest";
import { buildExplainButton } from "./ExplainButton.ts";
import { getExplainMode, _resetForTest } from "./explainMode.ts";

describe("ExplainButton", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    _resetForTest();
  });

  it("renders button + hidden popover", () => {
    const root = buildExplainButton();
    document.body.appendChild(root);
    expect(root.querySelector(".explain-button")).not.toBeNull();
    expect(
      (root.querySelector(".explain-popover") as HTMLDivElement).hidden,
    ).toBe(true);
  });

  it("opens popover on button click", () => {
    const root = buildExplainButton();
    document.body.appendChild(root);
    (root.querySelector(".explain-button") as HTMLButtonElement).click();
    expect(
      (root.querySelector(".explain-popover") as HTMLDivElement).hidden,
    ).toBe(false);
  });

  it("picking a swatch activates explain mode with that color", () => {
    const root = buildExplainButton();
    document.body.appendChild(root);
    (root.querySelector(".explain-button") as HTMLButtonElement).click();
    (root.querySelector('.explain-popover [data-color="green"]') as HTMLButtonElement).click();
    expect(getExplainMode()).toEqual({ active: true, color: "green" });
  });

  it("Off button deactivates", () => {
    const root = buildExplainButton();
    document.body.appendChild(root);
    (root.querySelector(".explain-button") as HTMLButtonElement).click();
    (root.querySelector('.explain-popover [data-color="red"]') as HTMLButtonElement).click();
    expect(getExplainMode().active).toBe(true);

    (root.querySelector(".explain-button") as HTMLButtonElement).click(); // open
    (root.querySelector(".explain-off") as HTMLButtonElement).click();
    expect(getExplainMode().active).toBe(false);
  });

  it("button reflects active state via data attrs", () => {
    const root = buildExplainButton();
    document.body.appendChild(root);
    const button = root.querySelector(".explain-button") as HTMLButtonElement;
    button.click();
    (root.querySelector('.explain-popover [data-color="pink"]') as HTMLButtonElement).click();
    expect(button.dataset.active).toBe("true");
    expect(button.dataset.color).toBe("pink");
  });

  it("clicking button while active toggles off", () => {
    const root = buildExplainButton();
    document.body.appendChild(root);
    const button = root.querySelector(".explain-button") as HTMLButtonElement;
    button.click();
    (root.querySelector('.explain-popover [data-color="blue"]') as HTMLButtonElement).click();
    expect(getExplainMode().active).toBe(true);
    button.click();
    expect(getExplainMode().active).toBe(false);
  });
});
