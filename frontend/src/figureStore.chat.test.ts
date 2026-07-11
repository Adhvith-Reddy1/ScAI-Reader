import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ChatStreamCallbacks } from "./api.ts";

const streamFigureChatMock = vi.fn();
const streamFigureExplanationMock = vi.fn();

vi.mock("./api.ts", () => ({
  streamFigureExplanation: (...args: unknown[]) =>
    streamFigureExplanationMock(...args) ?? (() => {}),
  streamFigureChat: (docId: string, figureId: string, body: unknown, cb: ChatStreamCallbacks) =>
    streamFigureChatMock(docId, figureId, body, cb) ?? (() => {}),
}));

vi.mock("./storage/localStore.ts", () => ({
  getExplanation: vi.fn().mockResolvedValue(null),
  putExplanation: vi.fn().mockResolvedValue(undefined),
}));

import { getFigureChat, seedFigure, sendFigureChatMessage } from "./figureStore.ts";

function lastCallbacks(): ChatStreamCallbacks {
  const calls = streamFigureChatMock.mock.calls;
  return calls[calls.length - 1][3];
}

describe("figureStore chat", () => {
  beforeEach(() => {
    streamFigureChatMock.mockReset().mockReturnValue(() => {});
    streamFigureExplanationMock.mockReset().mockReturnValue(() => {});
  });

  it("appends a user turn + a placeholder assistant turn and streams into it", () => {
    seedFigure("doc", "fig-1", "A bar chart of results.");
    sendFigureChatMessage("doc", "fig-1", 3, "Figure 1", "  why does that matter?  ");

    const chat = getFigureChat("doc", "fig-1");
    expect(chat.messages).toEqual([
      { role: "user", content: "why does that matter?" },
      { role: "assistant", content: "" },
    ]);
    expect(chat.streaming).toBe(true);

    // The request carries the current interpretation as `content`, the
    // figure's page/label/bbox, and only turns up to the question.
    const [docId, figureId, body] = streamFigureChatMock.mock.calls[0];
    expect(docId).toBe("doc");
    expect(figureId).toBe("fig-1");
    expect(body).toMatchObject({
      page: 3,
      label: "Figure 1",
      content: "A bar chart of results.",
      messages: [{ role: "user", content: "why does that matter?" }],
    });

    const cb = lastCallbacks();
    cb.onDelta("Because ");
    cb.onDelta("it shows a trend.");
    expect(getFigureChat("doc", "fig-1").messages[1].content).toBe(
      "Because it shows a trend.",
    );

    cb.onDone("Because it shows a trend.");
    expect(getFigureChat("doc", "fig-1").streaming).toBe(false);
  });

  it("forwards the bbox so the follow-up vision payload can crop to the panel", () => {
    seedFigure("doc", "fig-2", "A scatter plot.");
    const bbox = { x0: 10, y0: 20, x1: 100, y1: 120 };
    sendFigureChatMessage("doc", "fig-2", 1, "Figure 2a", "which axis?", bbox);

    expect(streamFigureChatMock.mock.calls[0][2]).toMatchObject({ bbox });
  });

  it("ignores blank questions and is a no-op while a reply is in flight", () => {
    seedFigure("doc", "fig-3", "x");
    sendFigureChatMessage("doc", "fig-3", 1, "Figure 3", "   ");
    expect(streamFigureChatMock).not.toHaveBeenCalled();

    sendFigureChatMessage("doc", "fig-3", 1, "Figure 3", "first");
    expect(streamFigureChatMock).toHaveBeenCalledTimes(1);
    // Still streaming -> second send is dropped.
    sendFigureChatMessage("doc", "fig-3", 1, "Figure 3", "second");
    expect(streamFigureChatMock).toHaveBeenCalledTimes(1);
  });

  it("drops the empty assistant turn and records the error on failure", () => {
    seedFigure("doc", "fig-4", "x");
    sendFigureChatMessage("doc", "fig-4", 1, "Figure 4", "q");
    lastCallbacks().onError("boom");

    const chat = getFigureChat("doc", "fig-4");
    expect(chat.streaming).toBe(false);
    expect(chat.error).toBe("boom");
    expect(chat.messages).toEqual([{ role: "user", content: "q" }]);
  });
});
