// @vitest-environment node
//
// Node env + `fake-indexeddb/auto` mirrors the localStore tests: it gives us a
// real IndexedDB on the global so the create -> list -> delete flow runs against
// the exact store the app ships, with no network in sight.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetDbPromiseForTest,
  deleteAnnotation,
  listAnnotations,
  putAnnotation,
} from "../storage/localStore.ts";
import { makeHighlight, type NewHighlight } from "./highlightModel.ts";

// RFC-4122 v4, the shape crypto.randomUUID() produces.
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function input(over: Partial<NewHighlight> = {}): NewHighlight {
  return {
    docId: "doc-1",
    page: 1,
    color: "yellow",
    rects: [{ x0: 1, y0: 2, x1: 3, y1: 4 }],
    text: "entropy",
    explain: false,
    ...over,
  };
}

beforeEach(() => {
  // Fresh DB per test so ids/contents don't leak between cases.
  globalThis.indexedDB = new IDBFactory();
  _resetDbPromiseForTest();
});

describe("makeHighlight", () => {
  it("builds a highlight with a client-generated id and ISO created_at", () => {
    const a = makeHighlight(input({ page: 2, color: "green" }));
    expect(a.kind).toBe("highlight");
    expect(a.docId).toBe("doc-1");
    expect(a.page).toBe(2);
    expect(a.color).toBe("green");
    expect(a.rects).toEqual([{ x0: 1, y0: 2, x1: 3, y1: 4 }]);
    expect(a.text).toBe("entropy");
    expect(a.id).toMatch(UUID_V4);
    // Round-trips through Date, i.e. it really is an ISO-8601 string.
    expect(new Date(a.created_at).toISOString()).toBe(a.created_at);
  });

  it("mints a unique id on every call", () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => makeHighlight(input()).id),
    );
    expect(ids.size).toBe(50);
  });

  it("preserves the explain flag for Spec 06 to hook into", () => {
    expect(makeHighlight(input({ explain: true })).explain).toBe(true);
    expect(makeHighlight(input({ explain: false })).explain).toBe(false);
  });

  it("stores null text when nothing was selected", () => {
    expect(makeHighlight(input({ text: null })).text).toBeNull();
  });
});

describe("create -> list -> delete through localStore (no network)", () => {
  it("persists, lists by doc and page, then deletes", async () => {
    const a = makeHighlight(input({ docId: "doc-1", page: 1 }));
    await putAnnotation(a);

    // Listed for its page...
    const onPage = await listAnnotations("doc-1", 1);
    expect(onPage.map((x) => x.id)).toEqual([a.id]);
    expect(onPage[0]).toEqual(a);

    // ...and for the whole doc...
    expect((await listAnnotations("doc-1")).map((x) => x.id)).toEqual([a.id]);

    // ...but not on a different page.
    expect(await listAnnotations("doc-1", 2)).toEqual([]);

    await deleteAnnotation("doc-1", a.id);
    expect(await listAnnotations("doc-1")).toEqual([]);
  });

  it("keeps highlights from different docs separate", async () => {
    const a = makeHighlight(input({ docId: "doc-1" }));
    const b = makeHighlight(input({ docId: "doc-2" }));
    await putAnnotation(a);
    await putAnnotation(b);

    expect((await listAnnotations("doc-1")).map((x) => x.id)).toEqual([a.id]);
    expect((await listAnnotations("doc-2")).map((x) => x.id)).toEqual([b.id]);
  });
});
