// @vitest-environment node
//
// Run in the node environment, not jsdom: node's native `Blob` and
// `structuredClone` understand each other, so PDF blobs survive the
// IndexedDB round-trip. jsdom's structuredClone drops its own Blobs to `{}`.
// Real-browser blob persistence is covered by the Playwright suite.
//
// `fake-indexeddb/auto` installs a real IndexedDB implementation onto the
// global so the store runs unmodified under Vitest.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetDbPromiseForTest,
  deleteAnnotation,
  deleteDocument,
  estimateUsage,
  getDocument,
  getExplanation,
  getViewState,
  listAnnotations,
  listDocuments,
  putAnnotation,
  putDocument,
  putExplanation,
  putViewState,
  type LocalAnnotation,
  type LocalDocument,
  type LocalExplanation,
} from "./localStore.ts";

function makeDoc(overrides: Partial<LocalDocument> = {}): LocalDocument {
  return {
    id: "doc-1",
    filename: "paper.pdf",
    page_count: 3,
    title: "A Paper",
    author: "An Author",
    size_bytes: 1234,
    added_at: "2026-01-01T00:00:00.000Z",
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "application/pdf" }),
    ...overrides,
  };
}

function makeAnnotation(
  overrides: Partial<LocalAnnotation> = {},
): LocalAnnotation {
  return {
    id: "ann-1",
    docId: "doc-1",
    page: 1,
    kind: "highlight",
    color: "yellow",
    rects: [{ x0: 0, y0: 0, x1: 1, y1: 1 }],
    text: "hello",
    explain: false,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeExplanation(
  overrides: Partial<LocalExplanation> = {},
): LocalExplanation {
  return {
    docId: "doc-1",
    annotationId: "ann-1",
    kind: "definition",
    text: "hello",
    content: "a greeting",
    status: "complete",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  // Fresh, empty database per test — wipe IndexedDB and the cached DB promise.
  globalThis.indexedDB = new IDBFactory();
  _resetDbPromiseForTest();
});

describe("documents", () => {
  it("put/get round-trips including the blob", async () => {
    const doc = makeDoc();
    await putDocument(doc);

    const got = await getDocument("doc-1");
    expect(got).not.toBeNull();
    expect(got!.filename).toBe("paper.pdf");
    expect(got!.page_count).toBe(3);
    // The PDF bytes survive the round-trip as a Blob of the same size/type.
    expect(got!.blob).toBeInstanceOf(Blob);
    expect(got!.blob.size).toBe(doc.blob.size);
    expect(got!.blob.type).toBe("application/pdf");
  });

  it("getDocument returns null for an unknown id", async () => {
    expect(await getDocument("missing")).toBeNull();
  });

  it("listDocuments returns metadata only, never blobs", async () => {
    await putDocument(makeDoc({ id: "doc-1" }));
    await putDocument(makeDoc({ id: "doc-2", filename: "other.pdf" }));

    const list = await listDocuments();
    expect(list).toHaveLength(2);
    for (const meta of list) {
      expect("blob" in meta).toBe(false);
    }
    expect(list.map((d) => d.id).sort()).toEqual(["doc-1", "doc-2"]);
  });

  it("persists across a DB re-open (write, drop promise, read back)", async () => {
    await putDocument(makeDoc());

    // Simulate a new session: same IndexedDB, fresh connection.
    _resetDbPromiseForTest();

    const got = await getDocument("doc-1");
    expect(got).not.toBeNull();
    expect(got!.filename).toBe("paper.pdf");
  });
});

describe("annotations", () => {
  it("put/list/delete for a document", async () => {
    await putAnnotation(makeAnnotation({ id: "a", page: 1 }));
    await putAnnotation(makeAnnotation({ id: "b", page: 2 }));

    const all = await listAnnotations("doc-1");
    expect(all.map((a) => a.id).sort()).toEqual(["a", "b"]);

    await deleteAnnotation("doc-1", "a");
    const after = await listAnnotations("doc-1");
    expect(after.map((a) => a.id)).toEqual(["b"]);
  });

  it("listAnnotations filters by page via the by_doc_page index", async () => {
    await putAnnotation(makeAnnotation({ id: "a", page: 1 }));
    await putAnnotation(makeAnnotation({ id: "b", page: 2 }));
    await putAnnotation(makeAnnotation({ id: "c", page: 2 }));

    expect((await listAnnotations("doc-1", 1)).map((a) => a.id)).toEqual(["a"]);
    expect(
      (await listAnnotations("doc-1", 2)).map((a) => a.id).sort(),
    ).toEqual(["b", "c"]);
    expect(await listAnnotations("doc-1", 99)).toEqual([]);
  });

  it("by_doc index isolates annotations between documents", async () => {
    await putAnnotation(makeAnnotation({ id: "a", docId: "doc-1" }));
    await putAnnotation(makeAnnotation({ id: "b", docId: "doc-2" }));

    expect((await listAnnotations("doc-1")).map((a) => a.id)).toEqual(["a"]);
    expect((await listAnnotations("doc-2")).map((a) => a.id)).toEqual(["b"]);
  });

  it("deleteAnnotation will not delete across documents", async () => {
    await putAnnotation(makeAnnotation({ id: "a", docId: "doc-1" }));

    // Wrong docId — must be a no-op.
    await deleteAnnotation("doc-2", "a");
    expect((await listAnnotations("doc-1")).map((a) => a.id)).toEqual(["a"]);
  });
});

describe("explanations", () => {
  it("put/get keyed by [docId, annotationId]", async () => {
    await putExplanation(makeExplanation());
    const got = await getExplanation("doc-1", "ann-1");
    expect(got).not.toBeNull();
    expect(got!.content).toBe("a greeting");
    expect(got!.kind).toBe("definition");
  });

  it("getExplanation returns null when absent", async () => {
    expect(await getExplanation("doc-1", "nope")).toBeNull();
  });

  it("the composite key separates explanations across docs/annotations", async () => {
    await putExplanation(makeExplanation({ annotationId: "ann-1", content: "x" }));
    await putExplanation(makeExplanation({ annotationId: "ann-2", content: "y" }));
    await putExplanation(
      makeExplanation({ docId: "doc-2", annotationId: "ann-1", content: "z" }),
    );

    expect((await getExplanation("doc-1", "ann-1"))!.content).toBe("x");
    expect((await getExplanation("doc-1", "ann-2"))!.content).toBe("y");
    expect((await getExplanation("doc-2", "ann-1"))!.content).toBe("z");
  });
});

describe("view state", () => {
  it("put/get round-trips", async () => {
    await putViewState({
      docId: "doc-1",
      lastPage: 5,
      zoom: 1.5,
      sidebarOpen: true,
    });
    const vs = await getViewState("doc-1");
    expect(vs).toEqual({
      docId: "doc-1",
      lastPage: 5,
      zoom: 1.5,
      sidebarOpen: true,
    });
  });

  it("getViewState returns null for an unknown doc", async () => {
    expect(await getViewState("missing")).toBeNull();
  });
});

describe("deleteDocument cascade", () => {
  it("removes the document plus its annotations, explanations, and viewState", async () => {
    // doc-1 with two annotations, two explanations, and a view state.
    await putDocument(makeDoc({ id: "doc-1" }));
    await putAnnotation(makeAnnotation({ id: "a", docId: "doc-1", page: 1 }));
    await putAnnotation(makeAnnotation({ id: "b", docId: "doc-1", page: 2 }));
    await putExplanation(makeExplanation({ docId: "doc-1", annotationId: "a" }));
    await putExplanation(makeExplanation({ docId: "doc-1", annotationId: "b" }));
    await putViewState({
      docId: "doc-1",
      lastPage: 2,
      zoom: 1,
      sidebarOpen: false,
    });

    // A second, untouched document whose data must survive the cascade.
    await putDocument(makeDoc({ id: "doc-2" }));
    await putAnnotation(makeAnnotation({ id: "c", docId: "doc-2" }));
    await putExplanation(makeExplanation({ docId: "doc-2", annotationId: "c" }));
    await putViewState({
      docId: "doc-2",
      lastPage: 1,
      zoom: 1,
      sidebarOpen: true,
    });

    await deleteDocument("doc-1");

    // doc-1 is fully gone.
    expect(await getDocument("doc-1")).toBeNull();
    expect(await listAnnotations("doc-1")).toEqual([]);
    expect(await getExplanation("doc-1", "a")).toBeNull();
    expect(await getExplanation("doc-1", "b")).toBeNull();
    expect(await getViewState("doc-1")).toBeNull();

    // doc-2 is untouched.
    expect(await getDocument("doc-2")).not.toBeNull();
    expect((await listAnnotations("doc-2")).map((a) => a.id)).toEqual(["c"]);
    expect(await getExplanation("doc-2", "c")).not.toBeNull();
    expect(await getViewState("doc-2")).not.toBeNull();
  });

  it("cascade persists after the DB re-opens", async () => {
    await putDocument(makeDoc({ id: "doc-1" }));
    await putAnnotation(makeAnnotation({ id: "a", docId: "doc-1" }));
    await deleteDocument("doc-1");

    _resetDbPromiseForTest();

    expect(await getDocument("doc-1")).toBeNull();
    expect(await listAnnotations("doc-1")).toEqual([]);
  });
});

describe("estimateUsage", () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
    });
  });

  function stubNavigator(value: unknown): void {
    Object.defineProperty(globalThis, "navigator", {
      value,
      configurable: true,
    });
  }

  it("returns usage/quota when the API is available", async () => {
    stubNavigator({
      storage: {
        estimate: vi.fn().mockResolvedValue({ usage: 100, quota: 1000 }),
      },
    });
    expect(await estimateUsage()).toEqual({
      usageBytes: 100,
      quotaBytes: 1000,
    });
  });

  it("returns null when navigator.storage is missing", async () => {
    stubNavigator({});
    expect(await estimateUsage()).toBeNull();
  });

  it("returns null when estimate() omits usage/quota", async () => {
    stubNavigator({
      storage: { estimate: vi.fn().mockResolvedValue({}) },
    });
    expect(await estimateUsage()).toBeNull();
  });
});
