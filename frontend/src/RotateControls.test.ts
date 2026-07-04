import { afterEach, describe, expect, it } from "vitest";
import { buildRotateControls } from "./RotateControls.ts";
import { _resetForTest, getRotation } from "./rotation.ts";

afterEach(() => _resetForTest());

describe("RotateControls", () => {
  it("renders a left and a right button with accessible labels", () => {
    const el = buildRotateControls();
    const btns = el.querySelectorAll("button.rotate-button");
    expect(btns.length).toBe(2);
    expect(btns[0].getAttribute("aria-label")).toBe("Rotate left");
    expect(btns[1].getAttribute("aria-label")).toBe("Rotate right");
  });

  it("rotate right steps +90, rotate left steps -90", () => {
    const el = buildRotateControls();
    const [left, right] = Array.from(
      el.querySelectorAll<HTMLButtonElement>("button.rotate-button"),
    );
    right.click();
    expect(getRotation()).toBe(90);
    right.click();
    expect(getRotation()).toBe(180);
    left.click();
    expect(getRotation()).toBe(90);
    left.click();
    left.click();
    expect(getRotation()).toBe(270);
  });
});
