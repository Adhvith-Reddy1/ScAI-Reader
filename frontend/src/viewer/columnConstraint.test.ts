import { describe, it, expect, beforeEach } from "vitest";
import {
  clampFocusToColumn,
  clipRangeToColumn,
  columnOf,
  _resetForTest,
} from "./columnConstraint.ts";

function makeTwoColumnDom(): {
  layer: HTMLDivElement;
  col1: HTMLDivElement;
  col2: HTMLDivElement;
  col1Spans: HTMLSpanElement[];
  col2Spans: HTMLSpanElement[];
} {
  const layer = document.createElement("div");
  layer.className = "text-layer";

  const col1 = document.createElement("div");
  col1.className = "text-column";
  const col2 = document.createElement("div");
  col2.className = "text-column";

  const col1Spans: HTMLSpanElement[] = [];
  const col2Spans: HTMLSpanElement[] = [];
  for (let i = 0; i < 3; i++) {
    const s = document.createElement("span");
    s.className = "text-run";
    s.textContent = `L${i}_some_text`;
    col1.appendChild(s);
    col1Spans.push(s);
  }
  for (let i = 0; i < 3; i++) {
    const s = document.createElement("span");
    s.className = "text-run";
    s.textContent = `R${i}_some_text`;
    col2.appendChild(s);
    col2Spans.push(s);
  }
  layer.appendChild(col1);
  layer.appendChild(col2);
  document.body.appendChild(layer);
  return { layer, col1, col2, col1Spans, col2Spans };
}

describe("columnOf", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    _resetForTest();
  });

  it("resolves element to its enclosing column", () => {
    const { col1, col1Spans } = makeTwoColumnDom();
    expect(columnOf(col1Spans[0])).toBe(col1);
  });

  it("resolves a text node to its enclosing column", () => {
    const { col2, col2Spans } = makeTwoColumnDom();
    expect(columnOf(col2Spans[1].firstChild)).toBe(col2);
  });

  it("returns null for a node outside any column", () => {
    document.body.innerHTML = "<p>outside</p>";
    const p = document.querySelector("p");
    expect(columnOf(p)).toBe(null);
  });
});

describe("clampFocusToColumn (anchor-preserving)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    _resetForTest();
  });

  it("forward drag (focus after anchor): clamps focus to end of column", () => {
    const { col1, col1Spans, col2Spans } = makeTwoColumnDom();
    const anchor = col1Spans[0].firstChild!;
    const focus = col2Spans[1].firstChild!;
    const result = clampFocusToColumn(anchor, focus, col1)!;
    const lastCol1Text = col1Spans[col1Spans.length - 1].firstChild!;
    expect(result.node).toBe(lastCol1Text);
    expect(result.offset).toBe(lastCol1Text.textContent!.length);
  });

  it("backward drag (focus before anchor): clamps focus to start of column", () => {
    const { col2, col1Spans, col2Spans } = makeTwoColumnDom();
    const anchor = col2Spans[2].firstChild!;
    const focus = col1Spans[0].firstChild!;
    const result = clampFocusToColumn(anchor, focus, col2)!;
    const firstCol2Text = col2Spans[0].firstChild!;
    expect(result.node).toBe(firstCol2Text);
    expect(result.offset).toBe(0);
  });

  it("returns null for an empty column", () => {
    const layer = document.createElement("div");
    layer.className = "text-layer";
    const emptyCol = document.createElement("div");
    emptyCol.className = "text-column";
    layer.appendChild(emptyCol);
    document.body.appendChild(layer);
    const span = document.createElement("span");
    span.textContent = "outside";
    document.body.appendChild(span);
    const result = clampFocusToColumn(
      span.firstChild!,
      span.firstChild!,
      emptyCol,
    );
    expect(result).toBe(null);
  });
});

describe("clipRangeToColumn (legacy)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    _resetForTest();
  });

  it("returns null when range is already inside the column", () => {
    const { col1, col1Spans } = makeTwoColumnDom();
    const range = document.createRange();
    range.setStart(col1Spans[0].firstChild!, 0);
    range.setEnd(col1Spans[1].firstChild!, 5);
    expect(clipRangeToColumn(range, col1)).toBe(null);
  });

  it("clips a left-to-right cross-column range to the left column", () => {
    const { col1, col1Spans, col2Spans } = makeTwoColumnDom();
    const range = document.createRange();
    range.setStart(col1Spans[0].firstChild!, 0);
    range.setEnd(col2Spans[1].firstChild!, 5);
    const out = clipRangeToColumn(range, col1)!;
    expect(columnOf(out.endContainer)).toBe(col1);
  });
});
