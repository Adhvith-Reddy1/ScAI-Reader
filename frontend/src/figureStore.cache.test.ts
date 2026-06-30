import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FigureExplainCallbacks } from "./api.ts";
import type { LocalExplanation } from "./storage/localStore.ts";

const streamFigureMock = vi.fn(
  (
    _d: string,
    _f: string,
    _p: number,
    _l: string,
    _cb: FigureExplainCallbacks,
  ) => () => {},
);

vi.mock("./api.ts", () => ({
  streamFigureExplanation: (
    d: string,
    f: string,
    p: number,
    l: string,
    cb: FigureExplainCallbacks,
  ) => streamFigureMock(d, f, p, l, cb) ?? (() => {}),
}));

const getExplanationMock = vi.fn();
const putExplanationMock = vi.fn();

vi.mock("./storage/localStore.ts", () => ({
  getExplanation: (docId: string, annotationId: string) =>
    getExplanationMock(docId, annotationId),
  putExplanation: (e: LocalExplanation) => putExplanationMock(e),
}));

import {
  getFigureState,
  startFigureExplanation,
} from "./figureStore.ts";

function lastFigureCallbacks(): FigureExplainCallbacks {
  const calls = streamFigureMock.mock.calls;
  return calls[calls.length - 1][4];
}

describe("figureStore cache-first / write-through", () => {
  beforeEach(() => {
    streamFigureMock.mockReset().mockReturnValue(() => {});
    getExplanationMock.mockReset().mockResolvedValue(null);
    putExplanationMock.mockReset().mockResolvedValue(undefined);
  });

  it("cache hit (keyed by figure id) renders without streaming", async () => {
    getExplanationMock.mockResolvedValue({
      docId: "doc",
      annotationId: "fig-1",
      kind: "explanation",
      text: "Figure 1",
      content: "A bar chart of results.",
      status: "complete",
      updated_at: "2026-01-01T00:00:00.000Z",
    } satisfies LocalExplanation);

    await startFigureExplanation("doc", "fig-1", 2, "Figure 1");

    expect(getExplanationMock).toHaveBeenCalledWith("doc", "fig-1");
    expect(streamFigureMock).not.toHaveBeenCalled();
    expect(getFigureState("doc", "fig-1")).toEqual({
      status: "ready",
      content: "A bar chart of results.",
    });
  });

  it("cache miss streams and writes the result through under the figure id", async () => {
    await startFigureExplanation("doc", "fig-2", 5, "Figure 2");

    expect(streamFigureMock).toHaveBeenCalledTimes(1);
    const cb = lastFigureCallbacks();
    cb.onDelta("A scatter ");
    cb.onDelta("plot.");
    cb.onDone("A scatter plot.");

    expect(getFigureState("doc", "fig-2")).toEqual({
      status: "ready",
      content: "A scatter plot.",
    });
    expect(putExplanationMock).toHaveBeenCalledTimes(1);
    expect(putExplanationMock.mock.calls[0][0]).toMatchObject({
      docId: "doc",
      annotationId: "fig-2",
      kind: "explanation",
      text: "Figure 2",
      content: "A scatter plot.",
      status: "complete",
    });
  });
});
