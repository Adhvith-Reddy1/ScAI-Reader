import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  bindBlueAnnotation,
  dismissExplanationFor,
  _resetForTest as _resetTooltip,
} from "./ExplanationTooltip.ts";
import type { DocumentMeta } from "../api.ts";

// The tooltip pulls cached content from the store; mock the network bits so
// hydrate/start are inert and we drive state purely via seedExplanation.
vi.mock("../api.ts", () => ({
  getExplanation: vi.fn(async () => null),
  streamExplanation: vi.fn(() => () => {}),
  streamChat: vi.fn(() => () => {}),
  streamRefine: vi.fn(() => () => {}),
}));

import {
  seedExplanation,
  _resetForTest as _resetStore,
} from "../explanationStore.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const DOC: DocumentMeta = {
  id: "doc-1",
  filename: "f.pdf",
  page_count: 1,
  title: null,
  author: null,
};

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

function buildBlueHighlight(): SVGGElement {
  const wrap = document.createElement("div");
  wrap.className = "page-wrap";
  const svg = document.createElementNS(SVG_NS, "svg");
  const group = document.createElementNS(SVG_NS, "g") as SVGGElement;
  group.setAttribute("class", "annotation");
  const rect = document.createElementNS(SVG_NS, "rect");
  group.appendChild(rect);
  svg.appendChild(group);
  wrap.appendChild(svg);
  document.body.appendChild(wrap);
  stubRect(rect, { left: 20, top: 40, right: 120, bottom: 52 });
  stubRect(group, { left: 20, top: 40, right: 120, bottom: 52 });
  return group;
}

function hoverInto(group: SVGGElement): void {
  const wrap = group.closest(".page-wrap")!;
  wrap.dispatchEvent(
    new MouseEvent("mousemove", { clientX: 60, clientY: 46, bubbles: true }),
  );
}

/** Drive the full hover→dwell→show→pin flow and return the tooltip element. */
async function openAndPin(group: SVGGElement): Promise<HTMLElement> {
  await Promise.resolve(); // bindBlueAnnotation attaches on a microtask
  hoverInto(group);
  vi.advanceTimersByTime(300); // past DWELL_MS (200)
  await Promise.resolve(); // show() awaits hydrate
  const tip = document.querySelector<HTMLElement>(".explanation-tooltip")!;
  tip.querySelector<HTMLButtonElement>(".explanation-chat-open")!.click();
  return tip;
}

describe("ExplanationTooltip pin / dismiss", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetTooltip();
    _resetStore();
    document.body.innerHTML = "";
  });
  afterEach(() => {
    _resetTooltip();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens the chat when the follow-up affordance is clicked", async () => {
    seedExplanation("a", "definition", "A measure of disorder.");
    const group = buildBlueHighlight();
    bindBlueAnnotation(group, DOC, "a", "entropy");

    const tip = await openAndPin(group);

    expect(tip.classList.contains("is-pinned")).toBe(true);
    expect(
      getComputedStyle(tip.querySelector(".explanation-chat")!).display,
    ).not.toBe("none");
    // Close button is now visible, footer affordance hidden.
    expect(
      (tip.querySelector(".explanation-tooltip-close") as HTMLElement).style
        .display,
    ).toBe("block");
  });

  it("Escape closes a pinned conversation", async () => {
    seedExplanation("a", "definition", "x");
    const group = buildBlueHighlight();
    bindBlueAnnotation(group, DOC, "a", "entropy");
    const tip = await openAndPin(group);
    expect(tip.style.display).toBe("block");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(tip.style.display).toBe("none");
  });

  it("dismissExplanationFor closes a panel pinned to the deleted highlight", async () => {
    seedExplanation("a", "definition", "x");
    const group = buildBlueHighlight();
    bindBlueAnnotation(group, DOC, "a", "entropy");
    const tip = await openAndPin(group);
    expect(tip.style.display).toBe("block");

    // A different highlight's deletion must NOT close this panel.
    dismissExplanationFor("some-other-id");
    expect(tip.style.display).toBe("block");

    dismissExplanationFor("a");
    expect(tip.style.display).toBe("none");
  });
});
