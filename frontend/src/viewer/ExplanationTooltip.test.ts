import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  bindBlueAnnotation,
  dismissExplanationFor,
  showExplanationForNewHighlight,
  _resetForTest as _resetTooltip,
} from "./ExplanationTooltip.ts";
import type { ChatStreamCallbacks, DocumentMeta, ExplainCallbacks } from "../api.ts";
import { _resetForTest as _resetKeyPrompt } from "../UserKeyPrompt.ts";

// Capture the stream callbacks so tests can complete a chat turn, drive an
// explain error, and observe refine kick-offs. hydrate/start are otherwise
// inert so state comes from seedExplanation unless a test drives it directly.
const streamExplanationMock = vi.fn(
  (
    _d: string,
    _p: number,
    _t: string,
    _cb: ExplainCallbacks,
    _pt?: string,
  ) => () => {},
);
const streamChatMock = vi.fn(
  (_d: string, _b: unknown, _cb: ChatStreamCallbacks) => () => {},
);
const streamRefineMock = vi.fn(
  (_d: string, _b: unknown, _cb: ChatStreamCallbacks) => () => {},
);

vi.mock("../api.ts", () => ({
  AI_NOT_CONFIGURED_CODE: "ai_not_configured",
  AI_QUOTA_EXCEEDED_CODE: "ai_quota_exceeded",
  streamExplanation: (
    d: string,
    p: number,
    t: string,
    cb: ExplainCallbacks,
    pt?: string,
  ) => streamExplanationMock(d, p, t, cb, pt) ?? (() => {}),
  streamChat: (d: string, b: unknown, cb: ChatStreamCallbacks) =>
    streamChatMock(d, b, cb) ?? (() => {}),
  streamRefine: (d: string, b: unknown, cb: ChatStreamCallbacks) =>
    streamRefineMock(d, b, cb) ?? (() => {}),
}));

// The browser cache is consulted on hover (hydrate) — stub it to a miss so the
// tooltip's state is driven solely by seedExplanation in these UI tests.
vi.mock("../storage/localStore.ts", () => ({
  getExplanation: vi.fn().mockResolvedValue(null),
  putExplanation: vi.fn().mockResolvedValue(undefined),
}));

import {
  seedExplanation,
  _resetForTest as _resetStore,
} from "../explanationStore.ts";
import { getExplanation, putExplanation } from "../storage/localStore.ts";

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
  return streamChatMock.mock.calls[streamChatMock.mock.calls.length - 1][2];
}

describe("ExplanationTooltip pin / chat / resize", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetTooltip();
    _resetStore();
    _resetKeyPrompt();
    streamExplanationMock.mockReset().mockReturnValue(() => {});
    streamChatMock.mockReset().mockReturnValue(() => {});
    streamRefineMock.mockReset().mockReturnValue(() => {});
    document.body.innerHTML = "";
    localStorage.clear();
  });
  afterEach(() => {
    _resetTooltip();
    _resetKeyPrompt();
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("opens the chat and hides the footer (Delete) when pinned", async () => {
    seedExplanation("a", "definition", "A measure of disorder.");
    const group = buildBlueHighlight();
    bindBlueAnnotation(group, DOC, "a", 1, "entropy", vi.fn());

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
    bindBlueAnnotation(group, DOC, "a", 1, "entropy", onDelete);
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
    bindBlueAnnotation(group, DOC, "a", 1, "entropy", vi.fn());
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
    bindBlueAnnotation(group, DOC, "a", 1, "entropy", vi.fn());
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
    bindBlueAnnotation(group, DOC, "a", 1, "entropy", vi.fn());
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
    bindBlueAnnotation(group, DOC, "a", 1, "entropy", vi.fn());
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
    bindBlueAnnotation(group, DOC, "a", 1, "entropy", vi.fn());
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
    bindBlueAnnotation(group, DOC, "a", 1, "entropy", vi.fn());
    const tip = await openAndPin(group);
    expect(tip.style.display).toBe("flex");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(tip.style.display).toBe("none");
  });

  it("dismissExplanationFor closes a panel pinned to the deleted highlight", async () => {
    seedExplanation("a", "definition", "x");
    const group = buildBlueHighlight();
    bindBlueAnnotation(group, DOC, "a", 1, "entropy", vi.fn());
    const tip = await openAndPin(group);
    expect(tip.style.display).toBe("flex");

    dismissExplanationFor("some-other-id");
    expect(tip.style.display).toBe("flex");

    dismissExplanationFor("a");
    expect(tip.style.display).toBe("none");
  });

  it("a quota-exceeded error offers to add a personal key and retries", async () => {
    const group = buildBlueHighlight();
    bindBlueAnnotation(group, DOC, "a", 1, "entropy", vi.fn());
    await Promise.resolve(); // bindBlueAnnotation attaches on a microtask
    hoverInto(group);
    vi.advanceTimersByTime(300); // past DWELL_MS
    // show() awaits hydrate (a mocked cache miss), which itself awaits before
    // startExplanation's own cache-first check runs and finally calls
    // streamExplanation — flush a few microtask ticks for that chain.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(streamExplanationMock).toHaveBeenCalledTimes(1);
    const [, , , firstCallbacks] = streamExplanationMock.mock.calls[0];
    firstCallbacks.onError("Daily quota used up.", "ai_quota_exceeded");

    const tip = document.querySelector<HTMLElement>(".explanation-tooltip")!;
    expect(
      tip.querySelector(".explanation-tooltip-title")!.textContent,
    ).toBe("Daily free AI limit reached");
    const addKeyBtn = tip.querySelector<HTMLButtonElement>(
      ".explanation-setup-ai",
    )!;
    addKeyBtn.click();

    const dialog = document.querySelector<HTMLElement>(".ai-setup-dialog")!;
    expect(dialog).toBeTruthy();
    const input = dialog.querySelector<HTMLInputElement>(".ai-setup-input")!;
    input.value = "sk-personal-test";
    dialog.querySelector<HTMLButtonElement>(".ai-setup-save")!.click();
    // retryExplanation's startExplanation call awaits its own cache-first
    // check (mocked miss) before re-invoking streamExplanation.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // The dialog closes, the key is saved client-side only, and the original
    // request is retried automatically.
    expect(document.querySelector(".ai-setup-dialog")).toBeNull();
    expect(localStorage.getItem("scai.userApiKey")).toBe("sk-personal-test");
    expect(streamExplanationMock).toHaveBeenCalledTimes(2);
  });
});

describe("showExplanationForNewHighlight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetTooltip();
    _resetStore();
    _resetKeyPrompt();
    streamExplanationMock.mockReset().mockReturnValue(() => {});
    streamChatMock.mockReset().mockReturnValue(() => {});
    streamRefineMock.mockReset().mockReturnValue(() => {});
    // A prior describe block's `vi.restoreAllMocks()` strips these inline
    // vi.mock() factory mocks down to a bare vi.fn() (no "real"
    // implementation to restore to) — re-establish them so
    // writeThroughCache's `putExplanation(...).catch(...)` has a promise to
    // call `.catch` on.
    vi.mocked(getExplanation).mockReset().mockResolvedValue(null);
    vi.mocked(putExplanation).mockReset().mockResolvedValue(undefined);
    document.body.innerHTML = "";
    localStorage.clear();
  });
  afterEach(() => {
    _resetTooltip();
    _resetKeyPrompt();
    vi.useRealTimers();
    // Note: no vi.restoreAllMocks() here — it would strip the mocks above
    // back down to a bare vi.fn(), breaking any later test/file that reuses
    // this same mocked module.
    localStorage.clear();
  });

  it("opens the panel immediately in the collapsed look, without any hover/dwell", async () => {
    const group = buildBlueHighlight();
    showExplanationForNewHighlight(group, DOC, "a", 1, "entropy", vi.fn());
    // show() awaits hydrate, which awaits a cache read, before startExplanation
    // does its own cache-first check and finally calls streamExplanation.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const tip = document.querySelector<HTMLElement>(".explanation-tooltip")!;
    // Collapsed look — not the full pinned chat UI — matching how a normal
    // hover-opened tooltip renders.
    expect(tip.style.display).toBe("block");
    expect(tip.classList.contains("is-pinned")).toBe(false);
    expect(tip.querySelector<HTMLElement>(".explanation-chat")!.style.display).toBe(
      "none",
    );
    expect(
      tip.querySelector<HTMLElement>(".explanation-tooltip-foot")!.style.display,
    ).not.toBe("none");
    // The explanation stream kicked off right away.
    expect(streamExplanationMock).toHaveBeenCalledTimes(1);
  });

  it("stays visible while the explanation streams, with no cursor on the highlight", async () => {
    const group = buildBlueHighlight();
    showExplanationForNewHighlight(group, DOC, "a", 1, "entropy", vi.fn());
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const tip = document.querySelector<HTMLElement>(".explanation-tooltip")!;
    const [, , , callbacks] = streamExplanationMock.mock.calls[0];
    callbacks.onDelta("A measure ");
    expect(tip.style.display).toBe("block");
    expect(tip.querySelector(".explanation-tooltip-body")!.textContent).toBe(
      "A measure",
    );

    // Simulate the cursor never having been on the highlight at all — no
    // mousemove/mouseleave was ever dispatched over it — and let any hide
    // timer that would fire for an unpinned tooltip elapse.
    vi.advanceTimersByTime(1000);
    expect(tip.style.display).toBe("block");

    callbacks.onDone("A measure of disorder.");
    expect(tip.style.display).toBe("block");
    expect(tip.querySelector(".explanation-tooltip-body")!.textContent).toBe(
      "A measure of disorder.",
    );
  });

  it("dismisses via outside click", async () => {
    const group = buildBlueHighlight();
    showExplanationForNewHighlight(group, DOC, "a", 1, "entropy", vi.fn());
    await Promise.resolve();
    const tip = document.querySelector<HTMLElement>(".explanation-tooltip")!;

    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(tip.style.display).toBe("none");
  });

  it("dismisses via Escape", async () => {
    const group = buildBlueHighlight();
    showExplanationForNewHighlight(group, DOC, "a", 1, "entropy", vi.fn());
    await Promise.resolve();
    const tip = document.querySelector<HTMLElement>(".explanation-tooltip")!;

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(tip.style.display).toBe("none");
  });

  it("clicking inside the panel does not dismiss it", async () => {
    const group = buildBlueHighlight();
    showExplanationForNewHighlight(group, DOC, "a", 1, "entropy", vi.fn());
    await Promise.resolve();
    const tip = document.querySelector<HTMLElement>(".explanation-tooltip")!;

    tip.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(tip.style.display).toBe("block");
  });

  it("'Ask a follow-up' promotes it to the full pinned chat panel", async () => {
    seedExplanation("a", "definition", "A measure of disorder.");
    const group = buildBlueHighlight();
    showExplanationForNewHighlight(group, DOC, "a", 1, "entropy", vi.fn());
    await Promise.resolve();
    const tip = document.querySelector<HTMLElement>(".explanation-tooltip")!;

    tip.querySelector<HTMLButtonElement>(".explanation-chat-open")!.click();

    expect(tip.classList.contains("is-pinned")).toBe(true);
    expect(tip.querySelector<HTMLElement>(".explanation-chat")!.style.display).toBe(
      "flex",
    );

    // Now behaves exactly like a normal pinned panel: moving the cursor away
    // still doesn't close it, but outside click does.
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(tip.style.display).toBe("none");
  });

  it("reuses an already-cached explanation instead of re-streaming", async () => {
    seedExplanation("a", "definition", "cached answer");
    const group = buildBlueHighlight();
    showExplanationForNewHighlight(group, DOC, "a", 1, "entropy", vi.fn());
    await Promise.resolve();

    const tip = document.querySelector<HTMLElement>(".explanation-tooltip")!;
    expect(tip.style.display).toBe("block");
    expect(tip.querySelector(".explanation-tooltip-body")!.textContent).toBe(
      "cached answer",
    );
    expect(streamExplanationMock).not.toHaveBeenCalled();
  });
});
