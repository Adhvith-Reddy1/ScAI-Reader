import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPageIndicator } from "./PageIndicator.ts";
import {
  _resetForTest as resetPageNav,
  jumpToPage,
  setActivePageList,
  subscribePageInfo,
} from "./pageNav.ts";
import type { PageListHandle } from "./viewer/PageList.ts";

function fakePageList(currentPage = 1): PageListHandle & {
  emitCurrent: (p: number) => void;
} {
  const subs = new Set<(p: number) => void>();
  let current = currentPage;
  const scrollSpy = vi.fn();
  return {
    element: document.createElement("div"),
    dispose: vi.fn(),
    scrollToPage: scrollSpy,
    getCurrentPage: () => current,
    subscribeCurrentPage: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    emitCurrent: (p) => {
      current = p;
      for (const cb of subs) cb(p);
    },
  };
}

beforeEach(() => resetPageNav());
afterEach(() => {
  resetPageNav();
  document.body.innerHTML = "";
});

describe("pageNav state machine", () => {
  it("notifies subscribers on activate and on currentPage emit", () => {
    const seen: ({ current: number; total: number } | null)[] = [];
    subscribePageInfo((info) => seen.push(info));

    const list = fakePageList(1);
    setActivePageList(list, 10);
    expect(seen[seen.length - 1]).toEqual({ current: 1, total: 10 });

    list.emitCurrent(4);
    expect(seen[seen.length - 1]).toEqual({ current: 4, total: 10 });
  });

  it("emits null on clear", () => {
    const seen: ({ current: number; total: number } | null)[] = [];
    subscribePageInfo((info) => seen.push(info));
    setActivePageList(fakePageList(), 3);
    setActivePageList(null);
    expect(seen[seen.length - 1]).toBe(null);
  });

  it("jumpToPage delegates to active list", () => {
    const list = fakePageList(1);
    setActivePageList(list, 10);
    jumpToPage(5);
    expect(list.scrollToPage).toHaveBeenCalledWith(5);
  });
});

describe("PageIndicator widget", () => {
  it("is hidden when no document is active", () => {
    const el = buildPageIndicator();
    document.body.appendChild(el);
    expect(el.hasAttribute("hidden")).toBe(true);
  });

  it("shows current/total when a list is activated", () => {
    const el = buildPageIndicator();
    document.body.appendChild(el);
    setActivePageList(fakePageList(1), 42);
    expect(el.hasAttribute("hidden")).toBe(false);
    const input = el.querySelector(".page-indicator-input") as HTMLInputElement;
    const total = el.querySelector(".page-indicator-total") as HTMLElement;
    expect(input.value).toBe("1");
    expect(total.textContent).toBe("42");
  });

  it("updates the input as the current page changes (when not focused)", () => {
    const el = buildPageIndicator();
    document.body.appendChild(el);
    const list = fakePageList(1);
    setActivePageList(list, 10);
    list.emitCurrent(7);
    const input = el.querySelector(".page-indicator-input") as HTMLInputElement;
    expect(input.value).toBe("7");
  });

  it("commits a clamped jump on Enter", () => {
    const el = buildPageIndicator();
    document.body.appendChild(el);
    const list = fakePageList(1);
    setActivePageList(list, 10);
    const input = el.querySelector(".page-indicator-input") as HTMLInputElement;
    input.focus();
    input.value = "999"; // out of range, should clamp to 10
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(list.scrollToPage).toHaveBeenCalledWith(10);
    expect(input.value).toBe("10");
  });

  it("Escape restores the displayed page and does not jump", () => {
    const el = buildPageIndicator();
    document.body.appendChild(el);
    const list = fakePageList(3);
    setActivePageList(list, 10);
    const input = el.querySelector(".page-indicator-input") as HTMLInputElement;
    input.focus();
    input.value = "8";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(list.scrollToPage).not.toHaveBeenCalled();
    expect(input.value).toBe("3");
  });
});
