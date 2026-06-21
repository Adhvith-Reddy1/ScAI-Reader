import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  loadReferences,
  getReference,
  getReferencesState,
  subscribeReferences,
  type ReferencesState,
} from "./referenceStore.ts";
import type { ReferencesResponse } from "./api.ts";

function mockFetchSequence(responses: ReferencesResponse[]): void {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const body = responses[Math.min(i, responses.length - 1)];
      i++;
      return { ok: true, json: async () => body } as Response;
    }),
  );
}

/** Resolve once the store for `docId` reaches a terminal (non-loading) state. */
function waitForSettled(docId: string): Promise<ReferencesState> {
  return new Promise((resolve) => {
    const unsub = subscribeReferences(docId, (state) => {
      if (state.status !== "loading" && state.status !== "idle") {
        unsub();
        resolve(state);
      }
    });
  });
}

let docCounter = 0;
function freshDoc(): string {
  return `doc-${docCounter++}`;
}

describe("referenceStore", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.unstubAllGlobals());

  it("maps a complete response into a number→entry lookup", async () => {
    const doc = freshDoc();
    mockFetchSequence([
      {
        doc_id: doc,
        status: "complete",
        references: [
          { number: 1, authors: "A. Smith", title: "A foundational paper" },
          { number: 2, authors: "B. Jones", title: "A follow-up study" },
        ],
      },
    ]);
    loadReferences(doc);
    await waitForSettled(doc);

    expect(getReferencesState(doc).status).toBe("ready");
    expect(getReference(doc, 1)?.title).toBe("A foundational paper");
    expect(getReference(doc, 2)?.authors).toBe("B. Jones");
    expect(getReference(doc, 99)).toBeNull();
  });

  it("surfaces an empty bibliography", async () => {
    const doc = freshDoc();
    mockFetchSequence([{ doc_id: doc, status: "empty", references: [] }]);
    loadReferences(doc);
    const state = await waitForSettled(doc);
    expect(state.status).toBe("empty");
    expect(getReference(doc, 1)).toBeNull();
  });

  it("surfaces a parse error", async () => {
    const doc = freshDoc();
    mockFetchSequence([{ doc_id: doc, status: "error", references: [] }]);
    loadReferences(doc);
    const state = await waitForSettled(doc);
    expect(state.status).toBe("error");
  });

  it("polls while pending and settles when the parse completes", async () => {
    vi.useFakeTimers();
    const doc = freshDoc();
    mockFetchSequence([
      { doc_id: doc, status: "pending", references: [] },
      {
        doc_id: doc,
        status: "complete",
        references: [{ number: 1, authors: "A", title: "T" }],
      },
    ]);

    loadReferences(doc);
    // First fetch resolves -> still pending, schedules a poll.
    await vi.advanceTimersByTimeAsync(0);
    expect(getReferencesState(doc).status).toBe("loading");
    // Advance past the poll interval -> second fetch -> complete.
    await vi.advanceTimersByTimeAsync(1600);
    expect(getReferencesState(doc).status).toBe("ready");
    expect(getReference(doc, 1)?.title).toBe("T");
  });

  it("is idempotent — a second loadReferences does not refetch", async () => {
    const doc = freshDoc();
    mockFetchSequence([
      {
        doc_id: doc,
        status: "complete",
        references: [{ number: 1, authors: "A", title: "T" }],
      },
    ]);
    loadReferences(doc);
    await waitForSettled(doc);
    loadReferences(doc);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
