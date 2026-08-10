import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ChatStreamCallbacks, FigureExplainCallbacks, PageFigure } from "../api.ts";

const streamFigureExplanationMock = vi.fn(
  (..._args: unknown[]) => () => {},
);
const streamFigureChatMock = vi.fn(
  (_d: string, _f: string, _b: unknown, _cb: ChatStreamCallbacks) => () => {},
);

vi.mock("../api.ts", () => ({
  AI_NOT_CONFIGURED_CODE: "ai_not_configured",
  streamFigureExplanation: (
    d: string,
    f: string,
    p: number,
    l: string,
    cb: FigureExplainCallbacks,
    bbox?: unknown,
  ) => streamFigureExplanationMock(d, f, p, l, cb, bbox) ?? (() => {}),
  streamFigureChat: (d: string, f: string, b: unknown, cb: ChatStreamCallbacks) =>
    streamFigureChatMock(d, f, b, cb) ?? (() => {}),
}));

vi.mock("../storage/localStore.ts", () => ({
  getExplanation: vi.fn().mockResolvedValue(null),
  putExplanation: vi.fn().mockResolvedValue(undefined),
}));

import { seedFigure } from "../figureStore.ts";
import { showFigureCard, hideFigureCard, _resetForTest } from "./FigureCard.ts";

const RECT = { left: 100, top: 100, right: 300, bottom: 200 } as DOMRect;

function figure(id: string, label = "Figure 1"): PageFigure {
  return {
    figure_id: id,
    label,
    page: 1,
    bbox: { x0: 0, y0: 0, x1: 100, y1: 100 },
    caption_bbox: { x0: 0, y0: 0, x1: 100, y1: 20 },
  };
}

function lastChatCallbacks(): ChatStreamCallbacks {
  const calls = streamFigureChatMock.mock.calls;
  return calls[calls.length - 1][3];
}

/** Promote a ready, collapsed card into full pinned chat mode. */
function pin(card: HTMLElement): void {
  card.querySelector<HTMLButtonElement>(".explanation-chat-open")!.click();
}

describe("FigureCard collapsed / pinned chat", () => {
  beforeEach(() => {
    _resetForTest();
    streamFigureExplanationMock.mockReset().mockReturnValue(() => {});
    streamFigureChatMock.mockReset().mockReturnValue(() => {});
    document.body.innerHTML = "";
    localStorage.clear();
  });
  afterEach(() => {
    // ensureCard() registers a fresh document-level pointerdown/keydown
    // listener on every call (one per test, since each test starts from a
    // null cardEl). Closing explicitly before resetting keeps those stale
    // listeners inert — they early-return once their captured el is
    // hidden — instead of spuriously closing a later test's still-open card.
    hideFigureCard();
    _resetForTest();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  // Collapsed state — same shape as the highlight explanation tooltip's
  // collapsed look: interpretation text + "Ask a follow-up ›", no chat yet.
  it("opens collapsed with an Ask a follow-up button, not the full chat", () => {
    seedFigure("doc", "fig-1", "A bar chart of results.");
    showFigureCard("doc", figure("fig-1"), RECT);
    const card = document.querySelector<HTMLElement>(".figure-card")!;

    expect(card.style.display).toBe("block");
    expect(card.classList.contains("is-pinned")).toBe(false);
    expect(card.querySelector<HTMLElement>(".explanation-chat")!.style.display).toBe(
      "none",
    );
    expect(card.querySelector<HTMLElement>(".figure-card-foot")!.style.display).toBe(
      "flex",
    );
    expect(
      card.querySelector<HTMLElement>(".figure-card-close")!.style.display,
    ).toBe("none");
  });

  it("the Ask a follow-up footer stays hidden until the explanation is ready", () => {
    showFigureCard("doc", figure("fig-2"), RECT); // starts idle -> loading
    const card = document.querySelector<HTMLElement>(".figure-card")!;
    expect(card.querySelector<HTMLElement>(".figure-card-foot")!.style.display).toBe(
      "none",
    );
    expect(card.querySelector<HTMLElement>(".explanation-chat")!.style.display).toBe(
      "none",
    );
  });

  it("clicking Ask a follow-up pins the card into full chat mode", () => {
    seedFigure("doc", "fig-3", "A scatter plot.");
    showFigureCard("doc", figure("fig-3"), RECT);
    const card = document.querySelector<HTMLElement>(".figure-card")!;

    pin(card);

    expect(card.style.display).toBe("flex");
    expect(card.classList.contains("is-pinned")).toBe(true);
    expect(card.querySelector<HTMLElement>(".explanation-chat")!.style.display).toBe(
      "flex",
    );
    expect(card.querySelector<HTMLElement>(".figure-card-foot")!.style.display).toBe(
      "none",
    );
    expect(
      card.querySelector<HTMLElement>(".figure-card-close")!.style.display,
    ).toBe("block");
  });

  it("clicking outside a collapsed card closes it", () => {
    seedFigure("doc", "fig-4", "A bar chart of results.");
    showFigureCard("doc", figure("fig-4"), RECT);
    const card = document.querySelector<HTMLElement>(".figure-card")!;

    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(card.style.display).toBe("none");
  });

  it("clicking inside the card does not close it", () => {
    seedFigure("doc", "fig-5", "A scatter plot.");
    showFigureCard("doc", figure("fig-5"), RECT);

    const card = document.querySelector<HTMLElement>(".figure-card")!;
    card
      .querySelector(".figure-card-body")!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(card.style.display).toBe("block");
  });

  it("Escape closes the card", () => {
    seedFigure("doc", "fig-6", "x");
    showFigureCard("doc", figure("fig-6"), RECT);
    const card = document.querySelector<HTMLElement>(".figure-card")!;

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(card.style.display).toBe("none");
  });

  it("the close button closes a pinned card", () => {
    seedFigure("doc", "fig-7", "x");
    showFigureCard("doc", figure("fig-7"), RECT);
    const card = document.querySelector<HTMLElement>(".figure-card")!;
    pin(card);

    card.querySelector<HTMLButtonElement>(".figure-card-close")!.click();
    expect(card.style.display).toBe("none");
  });

  it("hideFigureCard closes it explicitly", () => {
    seedFigure("doc", "fig-8", "x");
    showFigureCard("doc", figure("fig-8"), RECT);
    const card = document.querySelector<HTMLElement>(".figure-card")!;

    hideFigureCard();
    expect(card.style.display).toBe("none");
  });

  it("reopening a different figure starts collapsed again, even if the previous one was pinned", () => {
    seedFigure("doc", "fig-9a", "x");
    showFigureCard("doc", figure("fig-9a"), RECT);
    let card = document.querySelector<HTMLElement>(".figure-card")!;
    pin(card);
    expect(card.classList.contains("is-pinned")).toBe(true);

    seedFigure("doc", "fig-9b", "y");
    showFigureCard("doc", figure("fig-9b", "Figure 2"), RECT);
    card = document.querySelector<HTMLElement>(".figure-card")!;
    expect(card.classList.contains("is-pinned")).toBe(false);
    expect(card.style.display).toBe("block");
  });

  it("shows the chat once pinned and streams a follow-up reply into the thread", () => {
    seedFigure("doc", "fig-10", "A bar chart of results.");
    showFigureCard("doc", figure("fig-10"), RECT);
    const card = document.querySelector<HTMLElement>(".figure-card")!;
    pin(card);

    expect(card.querySelector<HTMLElement>(".explanation-chat")!.style.display).toBe(
      "flex",
    );

    const input = card.querySelector<HTMLInputElement>(".explanation-chat-input")!;
    input.value = "why does that matter?";
    card
      .querySelector<HTMLFormElement>(".explanation-chat-form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(streamFigureChatMock).toHaveBeenCalledTimes(1);
    expect(streamFigureChatMock.mock.calls[0][2]).toMatchObject({
      page: 1,
      label: "Figure 1",
      content: "A bar chart of results.",
      messages: [{ role: "user", content: "why does that matter?" }],
    });
    // The input clears right away.
    expect(input.value).toBe("");

    lastChatCallbacks().onDelta("Because ");
    lastChatCallbacks().onDone("Because it shows a trend.");

    const thread = card.querySelector<HTMLElement>(".explanation-chat-thread")!;
    const messages = [...thread.querySelectorAll(".explanation-chat-msg")].map(
      (m) => m.textContent,
    );
    expect(messages).toEqual([
      "why does that matter?",
      "Because it shows a trend.",
    ]);
  });

  it("clicking outside while pinned and chatting still closes the card", () => {
    seedFigure("doc", "fig-11", "x");
    showFigureCard("doc", figure("fig-11"), RECT);
    const card = document.querySelector<HTMLElement>(".figure-card")!;
    pin(card);

    const input = card.querySelector<HTMLInputElement>(".explanation-chat-input")!;
    input.value = "follow up";
    card
      .querySelector<HTMLFormElement>(".explanation-chat-form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(card.style.display).toBe("none");
  });

  // Resize/cap behavior mirrors ExplanationTooltip's pinned panel exactly —
  // the bug this suite guards against is the card growing without limit as
  // the chat thread accumulates messages instead of capping and scrolling
  // internally. Only meaningful once pinned — the collapsed card isn't
  // resizable, same as the highlight tooltip's collapsed look.
  it("caps the card height (grow-then-scroll) once pinned", () => {
    seedFigure("doc", "fig-12", "x");
    showFigureCard("doc", figure("fig-12"), RECT);
    const card = document.querySelector<HTMLElement>(".figure-card")!;
    pin(card);

    // A bounded max-height is applied so the thread (overflow-y:auto) scrolls
    // instead of the card growing without limit. jsdom viewport is 768 tall.
    const cap = parseFloat(card.style.maxHeight);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(480);
    // Height is left to grow with content rather than pinned to a value.
    expect(card.style.height).toBe("");
  });

  it("has eight resize handles", () => {
    seedFigure("doc", "fig-13", "x");
    showFigureCard("doc", figure("fig-13"), RECT);
    const card = document.querySelector<HTMLElement>(".figure-card")!;

    const handles = card.querySelectorAll(".explanation-resize-handle");
    expect(handles.length).toBe(8);
    for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      expect(card.querySelector(`.resize-${dir}`)).toBeTruthy();
    }
  });

  it("dragging the SE handle resizes a pinned card", () => {
    seedFigure("doc", "fig-14", "x");
    showFigureCard("doc", figure("fig-14"), RECT);
    const card = document.querySelector<HTMLElement>(".figure-card")!;
    pin(card);

    card.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 100,
        right: 480,
        bottom: 360,
        width: 380,
        height: 260,
        x: 100,
        y: 100,
        toJSON() {},
      }) as DOMRect;
    card.style.left = "100px";
    card.style.top = "100px";

    const se = card.querySelector<HTMLElement>(".resize-se")!;
    se.dispatchEvent(
      new MouseEvent("pointerdown", { clientX: 480, clientY: 360, bubbles: true }),
    );
    window.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 580, clientY: 460 }),
    );
    window.dispatchEvent(new MouseEvent("pointerup", {}));

    expect(card.style.width).toBe("480px");
    expect(card.style.height).toBe("360px");
    expect(card.style.left).toBe("100px");
    expect(card.style.top).toBe("100px");
  });

  it("remembers the resized size after close and reopen", () => {
    seedFigure("doc", "fig-15", "x");
    showFigureCard("doc", figure("fig-15"), RECT);
    let card = document.querySelector<HTMLElement>(".figure-card")!;
    pin(card);

    card.getBoundingClientRect = () =>
      ({ width: 380, height: 260 }) as DOMRect;
    const se = card.querySelector<HTMLElement>(".resize-se")!;
    se.dispatchEvent(
      new MouseEvent("pointerdown", { clientX: 0, clientY: 0, bubbles: true }),
    );
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 100, clientY: 100 }));
    window.dispatchEvent(new MouseEvent("pointerup", {}));
    expect(card.style.width).toBe("480px"); // 380 + 100
    expect(card.style.height).toBe("360px"); // 260 + 100

    hideFigureCard();
    expect(card.style.display).toBe("none");

    showFigureCard("doc", figure("fig-15"), RECT);
    card = document.querySelector<HTMLElement>(".figure-card")!;
    pin(card);

    // Width is restored exactly; the remembered height comes back as the
    // grow-to cap (max-height) so the card still expands-then-scrolls.
    expect(card.style.width).toBe("480px");
    expect(card.style.maxHeight).toBe("360px");
    expect(card.style.height).toBe("");
  });

  it("persists resized size independently from the explanation tooltip's key", () => {
    seedFigure("doc", "fig-16", "x");
    showFigureCard("doc", figure("fig-16"), RECT);
    const card = document.querySelector<HTMLElement>(".figure-card")!;
    pin(card);

    card.getBoundingClientRect = () =>
      ({ width: 380, height: 260 }) as DOMRect;
    const se = card.querySelector<HTMLElement>(".resize-se")!;
    se.dispatchEvent(
      new MouseEvent("pointerdown", { clientX: 0, clientY: 0, bubbles: true }),
    );
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 40, clientY: 40 }));
    window.dispatchEvent(new MouseEvent("pointerup", {}));

    expect(localStorage.getItem("scai.figureBoxSize")).toBe(
      JSON.stringify({ width: 420, height: 300 }),
    );
    expect(localStorage.getItem("scai.explanationBoxSize")).toBeNull();
  });
});
