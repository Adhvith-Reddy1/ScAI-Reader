// `fake-indexeddb/auto` installs a real IndexedDB implementation onto the
// global (jsdom, the default environment here, has no IndexedDB of its own),
// so the panel's `listAnnotations` calls run against the exact store the app
// ships, with no network in sight.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForTest as resetAnnotationEvents, notifyAnnotationsChanged } from "./annotationEvents.ts";
import { _resetForTest as resetExplanationStore, seedExplanation } from "./explanationStore.ts";
import { buildHighlightsPanel } from "./Highlights.ts";
import { _resetForTest as resetPageNav, setActivePageList } from "./pageNav.ts";
import {
  _resetDbPromiseForTest,
  putAnnotation,
  type LocalAnnotation,
} from "./storage/localStore.ts";
import type { PageListHandle } from "./viewer/PageList.ts";

function fakePageList(): PageListHandle & { scrollSpy: ReturnType<typeof vi.fn> } {
  const scrollSpy = vi.fn();
  return {
    element: document.createElement("div"),
    dispose: () => {},
    scrollToPage: scrollSpy,
    getCurrentPage: () => 1,
    subscribeCurrentPage: () => () => {},
    scrollSpy,
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
  resetExplanationStore();
});
afterEach(() => {
  resetPageNav();
  resetAnnotationEvents();
  resetExplanationStore();
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

describe("Highlights panel — jump button", () => {
  it("every row gets a jump button that scrolls to its page without opening the detail", async () => {
    await putAnnotation(makeAnnotation({ id: "a", page: 4, explain: true }));

    const el = buildHighlightsPanel();
    document.body.appendChild(el);
    const list = fakePageList();
    setActivePageList(list, 10, "doc1");
    await new Promise((r) => setTimeout(r, 20));

    const jumpBtn = el.querySelector(".highlights-jump") as HTMLButtonElement;
    expect(jumpBtn).toBeTruthy();
    jumpBtn.click();

    expect(list.scrollSpy).toHaveBeenCalledWith(4);
    // Clicking the jump button must not also toggle the definition panel.
    expect(el.querySelector(".highlights-detail")?.hasAttribute("hidden")).toBe(true);
  });

  it("plain highlights also get a working jump button", async () => {
    await putAnnotation(makeAnnotation({ id: "a", page: 7, explain: false }));

    const el = buildHighlightsPanel();
    document.body.appendChild(el);
    const list = fakePageList();
    setActivePageList(list, 10, "doc1");
    await new Promise((r) => setTimeout(r, 20));

    (el.querySelector(".highlights-jump") as HTMLButtonElement).click();
    expect(list.scrollSpy).toHaveBeenCalledWith(7);
  });
});

describe("Highlights panel — inline definition toggle", () => {
  it("clicking an explanation row's body opens its current explanation text, and closes on a second click", async () => {
    await putAnnotation(makeAnnotation({ id: "a", explain: true }));
    seedExplanation("a", "definition", "A measure of disorder.");

    const el = buildHighlightsPanel();
    document.body.appendChild(el);
    setActivePageList(fakePageList(), 10, "doc1");
    await new Promise((r) => setTimeout(r, 20));

    const row = el.querySelector(".highlights-row") as HTMLElement;
    expect(row.classList.contains("highlights-row-clickable")).toBe(true);
    const detail = el.querySelector(".highlights-detail") as HTMLElement;
    expect(detail.hidden).toBe(true);

    row.click();
    expect(detail.hidden).toBe(false);
    expect(detail.querySelector(".highlights-detail-body")?.textContent).toContain(
      "A measure of disorder.",
    );

    row.click();
    expect(detail.hidden).toBe(true);
  });

  it("shows a fallback message when no explanation has been generated yet", async () => {
    await putAnnotation(makeAnnotation({ id: "a", explain: true }));

    const el = buildHighlightsPanel();
    document.body.appendChild(el);
    setActivePageList(fakePageList(), 10, "doc1");
    await new Promise((r) => setTimeout(r, 20));

    const row = el.querySelector(".highlights-row") as HTMLElement;
    row.click();
    await new Promise((r) => setTimeout(r, 20));

    expect(el.querySelector(".highlights-detail")?.textContent).toContain(
      "No explanation has been generated",
    );
  });

  it("does not make plain highlight rows clickable", async () => {
    await putAnnotation(makeAnnotation({ id: "a", explain: false }));

    const el = buildHighlightsPanel();
    document.body.appendChild(el);
    setActivePageList(fakePageList(), 10, "doc1");
    await new Promise((r) => setTimeout(r, 20));

    const row = el.querySelector(".highlights-row") as HTMLElement;
    expect(row.classList.contains("highlights-row-clickable")).toBe(false);
    row.click();
    expect(el.querySelector(".highlights-detail")).toBeNull();
  });

  it("only shows the current explanation content, not a chat thread", async () => {
    await putAnnotation(makeAnnotation({ id: "a", explain: true }));
    seedExplanation("a", "explanation", "Original text.");

    const el = buildHighlightsPanel();
    document.body.appendChild(el);
    setActivePageList(fakePageList(), 10, "doc1");
    await new Promise((r) => setTimeout(r, 20));

    const row = el.querySelector(".highlights-row") as HTMLElement;
    row.click();

    const detail = el.querySelector(".highlights-detail") as HTMLElement;
    expect(detail.textContent).toContain("Original text.");
    expect(detail.querySelector(".explanation-chat-thread")).toBeNull();
    expect(detail.querySelectorAll(".highlights-detail-body").length).toBe(1);
  });
});
