import { afterEach, describe, expect, it } from "vitest";
import {
  _resetForTest,
  computeBaseScale,
  getBaseScale,
  getFitMode,
  setDocumentBounds,
  setFitMode,
  setViewport,
  subscribeFit,
} from "./fit.ts";

afterEach(() => _resetForTest());

describe("computeBaseScale (pure)", () => {
  const doc = { maxWidthPt: 600, maxHeightPt: 800 };

  it("fit-width fills viewport width minus padding", () => {
    const scale = computeBaseScale({
      mode: "fit-width",
      viewportWidthPx: 1200,
      viewportHeightPx: 900,
      doc,
      horizontalPadPx: 48,
      verticalPadPx: 48,
    });
    // (1200 - 48) / 600 = 1.92
    expect(scale).toBeCloseTo(1.92, 4);
  });

  it("fit-page picks the tighter of width / height constraint", () => {
    // Tall narrow viewport: height is the constraint
    const tall = computeBaseScale({
      mode: "fit-page",
      viewportWidthPx: 1200,
      viewportHeightPx: 400,
      doc,
      horizontalPadPx: 48,
      verticalPadPx: 48,
    });
    // width: (1200-48)/600=1.92, height: (400-48)/800=0.44 → min=0.44
    expect(tall).toBeCloseTo(0.44, 4);
  });

  it("actual mode returns 96/72 regardless of viewport", () => {
    const scale = computeBaseScale({
      mode: "actual",
      viewportWidthPx: 100,
      viewportHeightPx: 100,
      doc,
      horizontalPadPx: 48,
      verticalPadPx: 48,
    });
    expect(scale).toBeCloseTo(96 / 72, 4);
  });

  it("falls back to 96/72 when no doc bounds set", () => {
    const scale = computeBaseScale({
      mode: "fit-width",
      viewportWidthPx: 1200,
      viewportHeightPx: 900,
      doc: null,
      horizontalPadPx: 48,
      verticalPadPx: 48,
    });
    expect(scale).toBeCloseTo(96 / 72, 4);
  });
});

describe("module state", () => {
  it("notifies subscribers on viewport change", () => {
    setDocumentBounds(600, 800);
    setViewport(1200, 900);
    const seen: number[] = [];
    subscribeFit((s) => seen.push(s));
    setViewport(800, 600);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeCloseTo((800 - 48) / 600, 4);
  });

  it("ignores a no-op viewport change", () => {
    setDocumentBounds(600, 800);
    setViewport(1200, 900);
    const seen: number[] = [];
    subscribeFit((s) => seen.push(s));
    setViewport(1200, 900);
    expect(seen.length).toBe(0);
  });

  it("setFitMode flips the derived scale", () => {
    setDocumentBounds(600, 800);
    setViewport(1200, 400);
    expect(getFitMode()).toBe("fit-width");
    const widthScale = getBaseScale();
    setFitMode("fit-page");
    expect(getBaseScale()).toBeLessThan(widthScale);
  });
});
