import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getRotation,
  rotateCW,
  rotateCCW,
  resetRotation,
  setActiveDoc,
  subscribeRotation,
  _resetForTest,
} from "./rotation.ts";

describe("rotation", () => {
  beforeEach(() => {
    _resetForTest();
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it("defaults to 0", () => {
    expect(getRotation()).toBe(0);
  });

  it("steps clockwise through 90/180/270 and wraps to 0", () => {
    setActiveDoc("doc1");
    rotateCW();
    expect(getRotation()).toBe(90);
    rotateCW();
    expect(getRotation()).toBe(180);
    rotateCW();
    expect(getRotation()).toBe(270);
    rotateCW();
    expect(getRotation()).toBe(0);
  });

  it("steps counter-clockwise (wraps below 0 to 270)", () => {
    setActiveDoc("doc1");
    rotateCCW();
    expect(getRotation()).toBe(270);
    rotateCCW();
    expect(getRotation()).toBe(180);
  });

  it("resets to 0", () => {
    setActiveDoc("doc1");
    rotateCW();
    resetRotation();
    expect(getRotation()).toBe(0);
  });

  it("notifies subscribers on change", () => {
    setActiveDoc("doc1");
    const seen: number[] = [];
    subscribeRotation((deg) => seen.push(deg));
    rotateCW();
    rotateCW();
    // Subscribers are notified on change only (no immediate emit), like zoom.
    expect(seen).toEqual([90, 180]);
  });

  it("persists rotation per document and reloads it", () => {
    setActiveDoc("docA");
    rotateCW();
    rotateCW(); // docA -> 180
    setActiveDoc("docB");
    expect(getRotation()).toBe(0); // independent doc
    rotateCW(); // docB -> 90
    setActiveDoc("docA");
    expect(getRotation()).toBe(180); // docA restored
    setActiveDoc("docB");
    expect(getRotation()).toBe(90);
  });

  it("survives a state reset by reloading from storage", () => {
    setActiveDoc("docX");
    rotateCW(); // -> 90 (persisted)
    _resetForTest();
    setActiveDoc("docX");
    expect(getRotation()).toBe(90);
  });

  it("tolerates localStorage failures", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    setActiveDoc("docErr");
    expect(() => rotateCW()).not.toThrow();
    expect(getRotation()).toBe(90); // in-memory still works
    spy.mockRestore();
  });
});
