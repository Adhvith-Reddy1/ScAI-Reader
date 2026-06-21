import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  bindBlueAnnotation,
  dismissExplanationFor,
  _resetForTest as _resetTooltip,
} from "./ExplanationTooltip.ts";
import type { ChatStreamCallbacks, DocumentMeta } from "../api.ts";

// Capture the stream callbacks so tests can complete a chat turn, and observe
// refine kick-offs. hydrate/start are inert so state comes from seedExplanation.
const streamChatMock = vi.fn(
  (_d: string, _a: string, _b: unknown, _cb: ChatStreamCallbacks) => () => {},
);
const streamRefineMock = vi.fn(
  (_d: string, _a: string, _b: unknown, _cb: ChatStreamCallbacks) => () => {},
);

vi.mock("../api.ts", () => ({
  getExplanation: vi.fn(async () => null),
  streamExplanation: vi.fn(() => () => {}),
  streamChat: (d: string, a: string, b: unknown, cb: ChatStreamCallbacks) =>
    streamChatMock(d, a, b, cb) ?? (() => {}),
  streamRefine: (d: string, a: string, b: unknown, cb: ChatStreamCallbacks) =>
    streamRefineMock(d, a, b, cb) ?? (() => {}),
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

function hoverInto(group: SVGGElement, x = 60, y = 46): void {
  const wrap = group.closest(".page-wrap")!;
  wrap.dispatchEvent(
    new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }),
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

function lastChatCallbacks(): ChatStreamCallbacks {
  return streamChatMock.mock.calls[streamChatMock.mock.calls.length - 1][3];
}

describe("ExplanationTooltip pin / chat / resize", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetTooltip();
    _resetStore();
    streamChatMock.mockReset().mockReturnValue(() => {});
    streamRefineMock.mockReset().mockReturnValue(() => {});
    document.body.innerHTML = "";
  });
  afterEach(() => {
    _resetTooltip();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens the chat and hides the footer (Delete) when pinned", async () => {
    seedExplanation("a", "definition", "A measure of disorder.");
    const group = buildBlueHighlight();
    bindBlueAnnotation(group, DOC, "a", "entropy", vi.fn());

    const tip = await openAndPin(group);

    expect(tip.classList.contains("is-pinned")).toBe(true);
    expect(tip.querySelector<HTMLElement>(".explanation-chat")!.style.display).toBe(
      "flex",
    );
    // While chatting we assume no intent to delete: the footer is hidden.
    expect(
      tip.querySelector<HTMLElement>(".explanation-tooltip-foot")!.style.display,
    ).toBe("none");
  });

  it("Delete in the collapsed footer invokes the highlight's onDelete", async () => {
    const onDelete = vi.fn();
    seedExplanation("a", "definition", "x");
    const group = buildBlueHighlight();
    bindBlueAnnotation(group, DOC, "a", "entropy", onDelete);
    await Promise.resolve();
    hoverInto(group);
    vi.advanceTimersByTime(300);
    await Promise.resolve();

    const tip = document.querySelector<HTMLElement>(".explanation-tooltip")!;
    expect(tip.querySelector<HTMLElement>(".explanation-tooltip-foot")!.style.display)
      .not.toBe("none");
    tip.querySelector<HTMLButtonElement>(".explanation-tooltip-delete")!.click();
    expect(onDelete).toHaveBeenCalledWith("a");
  });

  it("clicking outside the panel closes it", async () => {
    seedExplanation("a", "definition", "x");
    const group = buildBlueHighlight();
    bindBlueAnnotation(group, DOC, "a", "entropy", vi.fn());
    const tip = await openAndPin(group);
    expect(tip.style.display).toBe("flex");

    document.body.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    );
    expect(tip.style.display).toBe("none");
  });

  it("Update explanation closes the panel and refines in the background", async () => {
    seedExplanation("a", "definition", "old");
    const group = buildBlueHighlight();
    bindBlueAnnotation(group, DOC, "a", "entropy", vi.fn());
    const tip = await openAndPin(group);

    // Ask a follow-up, then complete the assistant reply so the conversation
    // has content and the "Update explanation" button enables.
    const input = tip.querySelector<HTMLInputElement>(".explanation-chat-input")!;
    input.value = "why here?";
    tip
      .querySelector<HTMLFormElement>(".explanation-chat-form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    lastChatCallbacks().onDone("because reasons");

    const apply = tip.querySelector<HTMLButtonElement>(
      ".explanation-chat-apply",
    )!;
    expect(apply.disabled).toBe(false);
    apply.click();

    // Panel is gone immediately…
    expect(tip.style.display).toBe("none");
    // …and the rewrite was kicked off in the background.
    expect(streamRefineMock).toHaveBeenCalledTimes(1);
  });

  it("caps the pinned panel height (grow-then-scroll) when not resized", async () => {
    seedExplanation("a", "definition", "x");
    const group = buildBlueHighlight();
    bindBlueAnnotation(group, DOC, "a", "entropy", vi.fn());
    const tip = await openAndPin(group);

    // A bounded max-height is applied so the thread (overflow-y:auto) scrolls
    // instead of the box growing without limit. jsdom viewport is 768 tall.
    const cap = parseFloat(tip.style.maxHeight);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(620);
    // Height is left to grow with content rather than pinned to a value.
    expect(tip.style.height).toBe("");
  });

  it("dragging the SE handle resizes the panel", async () => {
    seedExplanation("a", "definition", "x");
    const group = buildBlueHighlight();
    bindBlueAnnotation(group, DOC, "a", "entropy", vi.fn());
    const tip = await openAndPin(group);

    stubRect(tip, {
      left: 100,
      top: 100,
      right: 480,
      bottom: 360,
      width: 380,
      height: 260,
    });
    tip.style.left = "100px";
    tip.style.top = "100px";

    const se = tip.querySelector<HTMLElement>(".resize-se")!;
    se.dispatchEvent(
      new MouseEvent("pointerdown", { clientX: 480, clientY: 360, bubbles: true }),
    );
    window.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 580, clientY: 460 }),
    );
    window.dispatchEvent(new MouseEvent("pointerup", {}));

    expect(tip.style.width).toBe("480px");
    expect(tip.style.height).toBe("360px");
    expect(tip.style.left).toBe("100px");
    expect(tip.style.top).toBe("100px");
  });

  it("remembers the resized size after close and reopen", async () => {
    seedExplanation("a", "definition", "x");
    const group = buildBlueHighlight();
    bindBlueAnnotation(group, DOC, "a", "entropy", vi.fn());
    const tip = await openAndPin(group);

    stubRect(tip, { width: 380, height: 260 });
    const se = tip.querySelector<HTMLElement>(".resize-se")!;
    se.dispatchEvent(
      new MouseEvent("pointerdown", { clientX: 0, clientY: 0, bubbles: true }),
    );
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 100, clientY: 100 }));
    window.dispatchEvent(new MouseEvent("pointerup", {}));
    expect(tip.style.width).toBe("480px"); // 380 + 100
    expect(tip.style.height).toBe("360px"); // 260 + 100

    // Close, then hover + pin again — the size should be restored.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(tip.style.display).toBe("none");

    hoverInto(group, 500, 500); // move away to clear the pending hover
    hoverInto(group); // back onto the highlight
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    document
      .querySelector<HTMLButtonElement>(".explanation-chat-open")!
      .click();

    // Width is restored exactly; the remembered height comes back as the
    // grow-to cap (max-height) so the panel still expands-then-scrolls.
    expect(tip.style.width).toBe("480px");
    expect(tip.style.maxHeight).toBe("360px");
    expect(tip.style.height).toBe("");
  });

  it("Escape closes a pinned conversation", async () => {
    seedExplanation("a", "definition", "x");
    const group = buildBlueHighlight();
    bindBlueAnnotation(group, DOC, "a", "entropy", vi.fn());
    const tip = await openAndPin(group);
    expect(tip.style.display).toBe("flex");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(tip.style.display).toBe("none");
  });

  it("dismissExplanationFor closes a panel pinned to the deleted highlight", async () => {
    seedExplanation("a", "definition", "x");
    const group = buildBlueHighlight();
    bindBlueAnnotation(group, DOC, "a", "entropy", vi.fn());
    const tip = await openAndPin(group);
    expect(tip.style.display).toBe("flex");

    dismissExplanationFor("some-other-id");
    expect(tip.style.display).toBe("flex");

    dismissExplanationFor("a");
    expect(tip.style.display).toBe("none");
  });
});
