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

describe("FigureCard dismiss / follow-up chat", () => {
  beforeEach(() => {
    _resetForTest();
    streamFigureExplanationMock.mockReset().mockReturnValue(() => {});
    streamFigureChatMock.mockReset().mockReturnValue(() => {});
    document.body.innerHTML = "";
  });
  afterEach(() => {
    _resetForTest();
    vi.restoreAllMocks();
  });

  it("clicking outside the card closes it", () => {
    seedFigure("doc", "fig-1", "A bar chart of results.");
    showFigureCard("doc", figure("fig-1"), RECT);

    const card = document.querySelector<HTMLElement>(".figure-card")!;
    expect(card.style.display).toBe("block");

    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(card.style.display).toBe("none");
  });

  it("clicking inside the card does not close it", () => {
    seedFigure("doc", "fig-2", "A scatter plot.");
    showFigureCard("doc", figure("fig-2"), RECT);

    const card = document.querySelector<HTMLElement>(".figure-card")!;
    card
      .querySelector(".figure-card-body")!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(card.style.display).toBe("block");
  });

  it("Escape closes the card", () => {
    seedFigure("doc", "fig-3", "x");
    showFigureCard("doc", figure("fig-3"), RECT);
    const card = document.querySelector<HTMLElement>(".figure-card")!;

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(card.style.display).toBe("none");
  });

  it("the close button closes the card", () => {
    seedFigure("doc", "fig-4", "x");
    showFigureCard("doc", figure("fig-4"), RECT);
    const card = document.querySelector<HTMLElement>(".figure-card")!;

    card.querySelector<HTMLButtonElement>(".figure-card-close")!.click();
    expect(card.style.display).toBe("none");
  });

  it("hideFigureCard closes it explicitly", () => {
    seedFigure("doc", "fig-5", "x");
    showFigureCard("doc", figure("fig-5"), RECT);
    const card = document.querySelector<HTMLElement>(".figure-card")!;

    hideFigureCard();
    expect(card.style.display).toBe("none");
  });

  it("the follow-up chat is hidden until the explanation is ready", () => {
    showFigureCard("doc", figure("fig-6"), RECT); // starts idle -> loading
    const card = document.querySelector<HTMLElement>(".figure-card")!;
    expect(card.querySelector<HTMLElement>(".explanation-chat")!.style.display).toBe(
      "none",
    );
  });

  it("shows the chat once ready and streams a follow-up reply into the thread", () => {
    seedFigure("doc", "fig-7", "A bar chart of results.");
    showFigureCard("doc", figure("fig-7"), RECT);
    const card = document.querySelector<HTMLElement>(".figure-card")!;

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

  it("clicking outside while chatting still closes the card (no separate pinned state)", () => {
    seedFigure("doc", "fig-8", "x");
    showFigureCard("doc", figure("fig-8"), RECT);
    const card = document.querySelector<HTMLElement>(".figure-card")!;

    const input = card.querySelector<HTMLInputElement>(".explanation-chat-input")!;
    input.value = "follow up";
    card
      .querySelector<HTMLFormElement>(".explanation-chat-form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(card.style.display).toBe("none");
  });
});
