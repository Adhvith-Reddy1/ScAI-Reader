// `fake-indexeddb/auto` installs a real IndexedDB implementation onto the
// global (jsdom, the default environment here, has no IndexedDB of its own),
// so the panel's `listAnnotations` calls run against the exact store the app
// ships, with no network in sight.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetForTest as resetAnnotationEvents, notifyAnnotationsChanged } from "./annotationEvents.ts";
import { buildHighlightsPanel } from "./Highlights.ts";
import { _resetForTest as resetPageNav, setActivePageList } from "./pageNav.ts";
import {
  _resetDbPromiseForTest,
  putAnnotation,
  type LocalAnnotation,
} from "./storage/localStore.ts";
import type { PageListHandle } from "./viewer/PageList.ts";

function fakePageList(): PageListHandle {
  return {
    element: document.createElement("div"),
    dispose: () => {},
    scrollToPage: () => {},
    getCurrentPage: () => 1,
    subscribeCurrentPage: () => () => {},
  };
}

function makeAnnotation(overrides: Partial<LocalAnnotation> = {}): LocalAnnotation {
  return {
    id: "ann-1",
    docId: "doc1",
    page: 1,
    kind: "highlight",
    color: "yellow",
    rects: [{ x0: 0, y0: 0, x1: 1, y1: 1 }],
    text: "entropy",
    explain: false,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  _resetDbPromiseForTest();
  resetPageNav();
  resetAnnotationEvents();
});
afterEach(() => {
  resetPageNav();
  resetAnnotationEvents();
  document.body.innerHTML = "";
});

describe("Highlights panel", () => {
  it("shows the empty state when no document is active", () => {
    const el = buildHighlightsPanel();
    document.body.appendChild(el);
    expect(el.querySelector(".highlights-empty")?.textContent).toContain(
      "Open a document",
    );
  });

  it("shows a no-highlights state for a doc with none saved", async () => {
    const el = buildHighlightsPanel();
    document.body.appendChild(el);

    setActivePageList(fakePageList(), 10, "doc1");
    await new Promise((r) => setTimeout(r, 20));

    expect(el.querySelector(".highlights-empty")?.textContent).toContain(
      "No highlights yet",
    );
  });

  it("lists saved highlights for the active document, sorted by page", async () => {
    await putAnnotation(makeAnnotation({ id: "a", page: 2, text: "second", color: "blue" }));
    await putAnnotation(makeAnnotation({ id: "b", page: 1, text: "first", explain: true }));

    const el = buildHighlightsPanel();
    document.body.appendChild(el);
    setActivePageList(fakePageList(), 10, "doc1");
    await new Promise((r) => setTimeout(r, 20));

    const rows = el.querySelectorAll(".highlights-row");
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector(".highlights-text")?.textContent).toBe("first");
    expect(rows[0].querySelector(".highlights-meta")?.textContent).toBe(
      "Definition · Page 1",
    );
    expect(rows[1].querySelector(".highlights-text")?.textContent).toBe("second");
    expect(rows[1].querySelector(".highlights-meta")?.textContent).toBe(
      "Highlight · Page 2",
    );
  });

  it("does not show highlights belonging to a different document", async () => {
    await putAnnotation(makeAnnotation({ id: "a", docId: "doc2", text: "other doc" }));

    const el = buildHighlightsPanel();
    document.body.appendChild(el);
    setActivePageList(fakePageList(), 10, "doc1");
    await new Promise((r) => setTimeout(r, 20));

    expect(el.querySelector(".highlights-empty")?.textContent).toContain(
      "No highlights yet",
    );
  });

  it("refreshes when notified a highlight was added for the active doc", async () => {
    const el = buildHighlightsPanel();
    document.body.appendChild(el);
    setActivePageList(fakePageList(), 10, "doc1");
    await new Promise((r) => setTimeout(r, 20));
    expect(el.querySelectorAll(".highlights-row").length).toBe(0);

    await putAnnotation(makeAnnotation({ id: "a", text: "new one" }));
    notifyAnnotationsChanged("doc1");
    await new Promise((r) => setTimeout(r, 20));

    const rows = el.querySelectorAll(".highlights-row");
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector(".highlights-text")?.textContent).toBe("new one");
  });

  it("ignores annotation-change notifications for a different document", async () => {
    const el = buildHighlightsPanel();
    document.body.appendChild(el);
    setActivePageList(fakePageList(), 10, "doc1");
    await new Promise((r) => setTimeout(r, 20));

    await putAnnotation(makeAnnotation({ id: "a", docId: "doc2" }));
    notifyAnnotationsChanged("doc2");
    await new Promise((r) => setTimeout(r, 20));

    expect(el.querySelectorAll(".highlights-row").length).toBe(0);
  });

  it("switches back to the empty state when the document closes", async () => {
    await putAnnotation(makeAnnotation({ id: "a" }));

    const el = buildHighlightsPanel();
    document.body.appendChild(el);
    setActivePageList(fakePageList(), 10, "doc1");
    await new Promise((r) => setTimeout(r, 20));
    expect(el.querySelectorAll(".highlights-row").length).toBe(1);

    setActivePageList(null);
    expect(el.querySelector(".highlights-empty")?.textContent).toContain(
      "Open a document",
    );
  });
});
