import { describe, expect, it } from "vitest";
import { applyFindToTextLayer, clearFindMarks, markCurrent } from "./findInPage.ts";

function makeTextLayer(runs: string[]): HTMLDivElement {
  const layer = document.createElement("div");
  layer.className = "text-layer";
  const col = document.createElement("div");
  col.className = "text-column";
  for (const text of runs) {
    const span = document.createElement("span");
    span.className = "text-run";
    span.textContent = text;
    col.appendChild(span);
  }
  layer.appendChild(col);
  return layer;
}

describe("applyFindToTextLayer", () => {
  it("matches runs whose text contains the query (case-insensitive)", () => {
    const layer = makeTextLayer(["Hello world", "Goodbye", "Hello again"]);
    const hits = applyFindToTextLayer(layer, "hello");
    expect(hits.length).toBe(2);
    expect(hits[0].textContent).toBe("Hello world");
    expect(hits[1].textContent).toBe("Hello again");
    expect(layer.querySelectorAll(".find-match").length).toBe(2);
  });

  it("empty query returns no hits and clears existing marks", () => {
    const layer = makeTextLayer(["foo", "bar"]);
    applyFindToTextLayer(layer, "foo");
    expect(layer.querySelectorAll(".find-match").length).toBe(1);
    const hits = applyFindToTextLayer(layer, "");
    expect(hits.length).toBe(0);
    expect(layer.querySelectorAll(".find-match").length).toBe(0);
  });

  it("a new query supersedes the previous one (no leftover marks)", () => {
    const layer = makeTextLayer(["alpha", "beta", "gamma"]);
    applyFindToTextLayer(layer, "alpha");
    expect(layer.querySelectorAll(".find-match").length).toBe(1);
    applyFindToTextLayer(layer, "gamma");
    expect(layer.querySelectorAll(".find-match").length).toBe(1);
    expect(
      (layer.querySelector(".find-match") as HTMLElement).textContent,
    ).toBe("gamma");
  });

  it("clearFindMarks removes all find-related classes", () => {
    const layer = makeTextLayer(["alpha", "alpha"]);
    const hits = applyFindToTextLayer(layer, "alpha");
    markCurrent(hits[0]);
    expect(layer.querySelectorAll(".find-match-current").length).toBe(1);
    clearFindMarks(layer);
    expect(layer.querySelectorAll(".find-match").length).toBe(0);
    expect(layer.querySelectorAll(".find-match-current").length).toBe(0);
  });
});
