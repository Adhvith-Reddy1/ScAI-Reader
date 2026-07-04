import { afterEach, describe, expect, it } from "vitest";
import {
  _resetForTest,
  getRotation,
  isSideways,
  normalizeRotation,
  rotateCcw,
  rotateCw,
  setRotation,
  subscribeRotation,
} from "./rotation.ts";

afterEach(() => _resetForTest());

describe("rotation state", () => {
  it("starts at 0", () => {
    expect(getRotation()).toBe(0);
  });

  it("rotateCw steps through 90/180/270 and wraps to 0", () => {
    rotateCw();
    expect(getRotation()).toBe(90);
    rotateCw();
    expect(getRotation()).toBe(180);
    rotateCw();
    expect(getRotation()).toBe(270);
    rotateCw();
    expect(getRotation()).toBe(0);
  });

  it("rotateCcw wraps below 0 to 270", () => {
    rotateCcw();
    expect(getRotation()).toBe(270);
    rotateCcw();
    expect(getRotation()).toBe(180);
  });

  it("normalizeRotation snaps + wraps arbitrary degrees", () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(44)).toBe(0);
    expect(normalizeRotation(46)).toBe(90);
  });

  it("isSideways is true only for 90 and 270", () => {
    expect(isSideways(0)).toBe(false);
    expect(isSideways(90)).toBe(true);
    expect(isSideways(180)).toBe(false);
    expect(isSideways(270)).toBe(true);
  });

  it("notifies subscribers on change only, with the new value", () => {
    const seen: number[] = [];
    subscribeRotation((d) => seen.push(d));
    setRotation(90);
    setRotation(90); // no-op
    setRotation(0);
    expect(seen).toEqual([90, 0]);
  });

  it("unsubscribe stops notifications", () => {
    const seen: number[] = [];
    const off = subscribeRotation((d) => seen.push(d));
    setRotation(90);
    off();
    setRotation(180);
    expect(seen).toEqual([90]);
  });
});
