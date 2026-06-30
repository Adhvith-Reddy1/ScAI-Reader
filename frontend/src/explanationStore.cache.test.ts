import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ExplainCallbacks } from "./api.ts";
import type { LocalExplanation } from "./storage/localStore.ts";

// Capture the explain-stream callbacks so tests can drive onDone, and observe
// whether a stream was started at all (the cache-hit path must NOT start one).
const streamExplanationMock = vi.fn(
  (_d: string, _p: number, _t: string, _cb: ExplainCallbacks) => () => {},
);

vi.mock("./api.ts", () => ({
  streamExplanation: (
    d: string,
    p: number,
    t: string,
    cb: ExplainCallbacks,
  ) => streamExplanationMock(d, p, t, cb) ?? (() => {}),
  streamChat: vi.fn(() => () => {}),
  streamRefine: vi.fn(() => () => {}),
}));

const getExplanationMock = vi.fn();
const putExplanationMock = vi.fn();

vi.mock("./storage/localStore.ts", () => ({
  getExplanation: (docId: string, annotationId: string) =>
    getExplanationMock(docId, annotationId),
  putExplanation: (e: LocalExplanation) => putExplanationMock(e),
}));

import {
  _resetForTest,
  getExplanationState,
  hydrateExplanation,
  startExplanation,
} from "./explanationStore.ts";

function lastExplainCallbacks(): ExplainCallbacks {
  const calls = streamExplanationMock.mock.calls;
  return calls[calls.length - 1][3];
}

const cachedRow: LocalExplanation = {
  docId: "doc",
  annotationId: "a",
  kind: "definition",
  text: "entropy",
  content: "A measure of disorder.",
  status: "complete",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("explanationStore cache-first / write-through", () => {
  beforeEach(() => {
    _resetForTest();
    streamExplanationMock.mockReset().mockReturnValue(() => {});
    getExplanationMock.mockReset().mockResolvedValue(null);
    putExplanationMock.mockReset().mockResolvedValue(undefined);
  });

  it("cache hit: renders from cache and never starts a stream", async () => {
    getExplanationMock.mockResolvedValue(cachedRow);

    await startExplanation("doc", "a", "entropy", 3);

    expect(streamExplanationMock).not.toHaveBeenCalled();
    expect(getExplanationState("a")).toEqual({
      status: "ready",
      content: "A measure of disorder.",
      kind: "definition",
    });
  });

  it("cache miss: streams from /ai/explain with the page, no annotation id", async () => {
    await startExplanation("doc", "a", "entropy", 3);

    expect(streamExplanationMock).toHaveBeenCalledTimes(1);
    const [docId, page, text] = streamExplanationMock.mock.calls[0];
    expect({ docId, page, text }).toEqual({
      docId: "doc",
      page: 3,
      text: "entropy",
    });
  });

  it("write-through: a completed stream is persisted to the cache", async () => {
    await startExplanation("doc", "a", "entropy", 3);

    const cb = lastExplainCallbacks();
    cb.onMeta?.("definition", false);
    cb.onDelta("A measure ");
    cb.onDelta("of disorder.");
    cb.onDone("A measure of disorder.");

    expect(getExplanationState("a")).toMatchObject({
      status: "ready",
      content: "A measure of disorder.",
      kind: "definition",
    });
    expect(putExplanationMock).toHaveBeenCalledTimes(1);
    expect(putExplanationMock.mock.calls[0][0]).toMatchObject({
      docId: "doc",
      annotationId: "a",
      kind: "definition",
      text: "entropy",
      content: "A measure of disorder.",
      status: "complete",
    });
  });

  it("a stream error is not written to the cache", async () => {
    await startExplanation("doc", "a", "entropy", 3);
    lastExplainCallbacks().onError("boom");

    expect(getExplanationState("a")).toMatchObject({
      status: "error",
      error: "boom",
    });
    expect(putExplanationMock).not.toHaveBeenCalled();
  });

  it("hydrate returns true and goes ready on a complete cache row", async () => {
    getExplanationMock.mockResolvedValue(cachedRow);

    const hydrated = await hydrateExplanation("doc", "a");

    expect(hydrated).toBe(true);
    expect(getExplanationState("a")).toMatchObject({
      status: "ready",
      content: "A measure of disorder.",
    });
    expect(streamExplanationMock).not.toHaveBeenCalled();
  });

  it("hydrate returns false on a cache miss so the caller can stream", async () => {
    expect(await hydrateExplanation("doc", "a")).toBe(false);
    expect(getExplanationState("a")).toEqual({ status: "idle" });
  });
});
