import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOutlinePanel } from "./Outline.ts";
import {
  _resetForTest as resetPageNav,
  setActivePageList,
} from "./pageNav.ts";
import type { PageListHandle } from "./viewer/PageList.ts";
import type { OutlineNode } from "./api.ts";

function fakePageList(): PageListHandle & { scrollSpy: ReturnType<typeof vi.fn> } {
  const scrollSpy = vi.fn();
  return {
    element: document.createElement("div"),
    dispose: vi.fn(),
    scrollToPage: scrollSpy,
    getCurrentPage: () => 1,
    subscribeCurrentPage: () => () => {},
    scrollSpy,
  };
}

function stubFetchOutline(nodes: OutlineNode[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ doc_id: "doc1", nodes }),
    })) as unknown as typeof fetch,
  );
}

beforeEach(() => resetPageNav());
afterEach(() => {
  resetPageNav();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("Outline panel", () => {
  it("shows the empty state when no document is active", () => {
    const el = buildOutlinePanel();
    document.body.appendChild(el);
    expect(el.querySelector(".outline-empty")?.textContent).toContain(
      "Open a document",
    );
  });

  it("renders a nested tree with correct indentation when a doc activates", async () => {
    const nodes: OutlineNode[] = [
      {
        title: "Chapter 1",
        page: 1,
        children: [
          { title: "1.1 Intro", page: 2, children: [] },
        ],
      },
      { title: "Chapter 2", page: 3, children: [] },
    ];
    stubFetchOutline(nodes);

    const el = buildOutlinePanel();
    document.body.appendChild(el);

    setActivePageList(fakePageList(), 10, "doc1");
    await new Promise((r) => setTimeout(r, 0));

    const rows = el.querySelectorAll(".outline-row");
    expect(rows.length).toBe(3);
    expect(rows[0].querySelector(".outline-title")?.textContent).toBe("Chapter 1");
    expect((rows[0] as HTMLElement).style.paddingLeft).toBe("0px");
    expect((rows[1] as HTMLElement).style.paddingLeft).toBe("16px");
    expect(rows[1].querySelector(".outline-title")?.textContent).toBe("1.1 Intro");
    expect(rows[2].querySelector(".outline-title")?.textContent).toBe("Chapter 2");
    expect(rows[0].querySelector(".outline-page")?.textContent).toBe("1");
    expect(rows[1].querySelector(".outline-page")?.textContent).toBe("2");
  });

  it("clicking a node with a page calls jumpToPage on the active list", async () => {
    stubFetchOutline([{ title: "Chapter 1", page: 5, children: [] }]);

    const el = buildOutlinePanel();
    document.body.appendChild(el);
    const list = fakePageList();
    setActivePageList(list, 10, "doc1");
    await new Promise((r) => setTimeout(r, 0));

    const row = el.querySelector(".outline-row") as HTMLElement;
    row.click();
    expect(list.scrollSpy).toHaveBeenCalledWith(5);
  });

  it("nodes with null page are inert", async () => {
    stubFetchOutline([{ title: "No dest", page: null, children: [] }]);

    const el = buildOutlinePanel();
    document.body.appendChild(el);
    const list = fakePageList();
    setActivePageList(list, 10, "doc1");
    await new Promise((r) => setTimeout(r, 0));

    const row = el.querySelector(".outline-row") as HTMLElement;
    expect(row.classList.contains("outline-row-inert")).toBe(true);
    expect(row.classList.contains("outline-row-clickable")).toBe(false);
    row.click();
    expect(list.scrollToPage).not.toHaveBeenCalled();
  });

  it("expand/collapse toggle hides and shows children", async () => {
    stubFetchOutline([
      {
        title: "Chapter 1",
        page: 1,
        children: [{ title: "1.1", page: 2, children: [] }],
      },
    ]);

    const el = buildOutlinePanel();
    document.body.appendChild(el);
    setActivePageList(fakePageList(), 10, "doc1");
    await new Promise((r) => setTimeout(r, 0));

    const children = el.querySelector(".outline-children") as HTMLElement;
    expect(children.hidden).toBe(false);

    const toggle = el.querySelector(".outline-toggle") as HTMLButtonElement;
    toggle.click();
    expect(children.hidden).toBe(true);

    toggle.click();
    expect(children.hidden).toBe(false);
  });

  it("shows empty state when active doc has no outline entries", async () => {
    stubFetchOutline([]);

    const el = buildOutlinePanel();
    document.body.appendChild(el);
    setActivePageList(fakePageList(), 10, "doc1");
    await new Promise((r) => setTimeout(r, 0));

    expect(el.querySelector(".outline-empty")?.textContent).toContain("No outline");
  });
});
