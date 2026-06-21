import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ChatStreamCallbacks } from "./api.ts";

// Capture the callbacks each stream starts with so the test can drive deltas.
const streamChatMock = vi.fn();
const streamRefineMock = vi.fn();

vi.mock("./api.ts", () => ({
  getExplanation: vi.fn(),
  streamExplanation: vi.fn(),
  streamChat: (
    docId: string,
    annId: string,
    body: unknown,
    cb: ChatStreamCallbacks,
  ) => streamChatMock(docId, annId, body, cb) ?? (() => {}),
  streamRefine: (
    docId: string,
    annId: string,
    body: unknown,
    cb: ChatStreamCallbacks,
  ) => streamRefineMock(docId, annId, body, cb) ?? (() => {}),
}));

import {
  _resetForTest,
  getChat,
  getExplanationState,
  refineFromChat,
  seedExplanation,
  sendChatMessage,
} from "./explanationStore.ts";

function lastCallbacks(mock: typeof streamChatMock): ChatStreamCallbacks {
  return mock.mock.calls[mock.mock.calls.length - 1][3];
}

describe("explanationStore chat", () => {
  beforeEach(() => {
    _resetForTest();
    streamChatMock.mockReset().mockReturnValue(() => {});
    streamRefineMock.mockReset().mockReturnValue(() => {});
  });

  it("appends a user turn + a placeholder assistant turn and streams into it", () => {
    seedExplanation("a", "definition", "original");
    sendChatMessage("doc", "a", "entropy", "  why here?  ");

    const chat = getChat("a");
    expect(chat.messages).toEqual([
      { role: "user", content: "why here?" },
      { role: "assistant", content: "" },
    ]);
    expect(chat.streaming).toBe(true);

    // The request carries the current tooltip content/kind and only the turns
    // up to (and including) the question — never the empty placeholder.
    const [, , body] = streamChatMock.mock.calls[0];
    expect(body).toMatchObject({
      text: "entropy",
      kind: "definition",
      content: "original",
      messages: [{ role: "user", content: "why here?" }],
    });

    const cb = lastCallbacks(streamChatMock);
    cb.onDelta("Because");
    cb.onDelta(" so.");
    expect(getChat("a").messages[1].content).toBe("Because so.");

    cb.onDone("Because so.");
    expect(getChat("a").streaming).toBe(false);
  });

  it("ignores blank questions and is a no-op while a reply is in flight", () => {
    seedExplanation("a", "explanation", "x");
    sendChatMessage("doc", "a", "t", "   ");
    expect(streamChatMock).not.toHaveBeenCalled();

    sendChatMessage("doc", "a", "t", "first");
    expect(streamChatMock).toHaveBeenCalledTimes(1);
    // Still streaming → second send is dropped.
    sendChatMessage("doc", "a", "t", "second");
    expect(streamChatMock).toHaveBeenCalledTimes(1);
  });

  it("drops the empty assistant turn and records the error on failure", () => {
    seedExplanation("a", "definition", "x");
    sendChatMessage("doc", "a", "t", "q");
    lastCallbacks(streamChatMock).onError("boom");

    const chat = getChat("a");
    expect(chat.streaming).toBe(false);
    expect(chat.error).toBe("boom");
    expect(chat.messages).toEqual([{ role: "user", content: "q" }]);
  });

  it("refine streams into the body and leaves it as the ready content", () => {
    seedExplanation("a", "definition", "old text");
    sendChatMessage("doc", "a", "entropy", "q");
    lastCallbacks(streamChatMock).onDone("an answer");

    refineFromChat("doc", "a", "entropy");
    expect(getChat("a").refining).toBe(true);

    const cb = lastCallbacks(streamRefineMock);
    cb.onDelta("new ");
    cb.onDelta("definition");
    let st = getExplanationState("a");
    expect(st.status).toBe("loading");

    cb.onDone("new definition");
    st = getExplanationState("a");
    expect(st).toMatchObject({ status: "ready", content: "new definition" });
    expect(getChat("a").refining).toBe(false);
  });

  it("refine failure restores the original explanation text", () => {
    seedExplanation("a", "explanation", "keep me");
    sendChatMessage("doc", "a", "t", "q");
    lastCallbacks(streamChatMock).onDone("a");

    refineFromChat("doc", "a", "t");
    lastCallbacks(streamRefineMock).onError("nope");

    const st = getExplanationState("a");
    expect(st).toMatchObject({ status: "ready", content: "keep me" });
    expect(getChat("a").error).toBe("nope");
  });

  it("refine is a no-op when there's no conversation yet", () => {
    seedExplanation("a", "definition", "x");
    refineFromChat("doc", "a", "t");
    expect(streamRefineMock).not.toHaveBeenCalled();
  });
});
