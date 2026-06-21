import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bindHighlightActions } from "./HighlightHoverActions.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

function stubRect(el: Element, r: Partial<DOMRect>): void {
  el.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      ...r,
      toJSON() {},
    }) as DOMRect;
}

/** Build a page-wrap with one highlight group whose rect spans 10..60 × 10..30. */
function buildWrap(id: string): { wrap: HTMLElement; group: SVGGElement } {
  const wrap = document.createElement("div");
  wrap.className = "page-wrap";
  const svg = document.createElementNS(SVG_NS, "svg");
  const group = document.createElementNS(SVG_NS, "g") as SVGGElement;
  group.setAttribute("class", "annotation");
  group.setAttribute("data-annotation-id", id);
  const rect = document.createElementNS(SVG_NS, "rect");
  group.appendChild(rect);
  svg.appendChild(group);
  wrap.appendChild(svg);
  document.body.appendChild(wrap);
  stubRect(rect, { left: 10, top: 10, right: 60, bottom: 30 });
  stubRect(group, { left: 10, top: 10, right: 60, bottom: 30 });
  return { wrap, group };
}

function move(wrap: HTMLElement, x: number, y: number): void {
  wrap.dispatchEvent(
    new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }),
  );
}

describe("bindHighlightActions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("shows the Delete button when the cursor is over a highlight and deletes on click", async () => {
    const onDelete = vi.fn();
    const { wrap } = buildWrap("hl-1");
    bindHighlightActions(
      document.querySelector("g.annotation") as SVGGElement,
      "hl-1",
      onDelete,
    );
    // Registration attaches on a microtask once the group is in the DOM.
    await Promise.resolve();

    move(wrap, 30, 20); // inside 10..60 × 10..30

    const box = document.querySelector<HTMLElement>(".highlight-actions");
    expect(box).not.toBeNull();
    expect(box!.style.display).toBe("block");

    const btn = box!.querySelector<HTMLButtonElement>(
      ".highlight-actions-delete",
    )!;
    btn.click();
    expect(onDelete).toHaveBeenCalledWith("hl-1");
    // Hidden again after the click.
    expect(box!.style.display).toBe("none");
  });

  it("does not surface the button when the cursor misses every highlight", async () => {
    const onDelete = vi.fn();
    const { wrap } = buildWrap("hl-2");
    bindHighlightActions(
      document.querySelector("g.annotation") as SVGGElement,
      "hl-2",
      onDelete,
    );
    await Promise.resolve();

    move(wrap, 200, 200); // well outside the highlight rect

    const box = document.querySelector<HTMLElement>(".highlight-actions");
    // Either no box yet, or it stayed hidden.
    expect(box == null || box.style.display === "none").toBe(true);
    expect(onDelete).not.toHaveBeenCalled();
  });
});
