import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetForTest,
  getCurrentIndex,
  getQuery,
  getTotalMatches,
  next,
  prev,
  registerPageAdapter,
  setQuery,
  subscribeMatches,
  subscribeQuery,
  unregisterPage,
  type PageMatchAdapter,
} from "./findState.ts";

function makeAdapter(page: number, count: number): PageMatchAdapter & {
  scrollSpy: ReturnType<typeof vi.fn>;
  clearSpy: ReturnType<typeof vi.fn>;
} {
  const scrollSpy = vi.fn();
  const clearSpy = vi.fn();
  return {
    page,
    count,
    scrollToMatchAndMark: scrollSpy,
    clearActiveMark: clearSpy,
    scrollSpy,
    clearSpy,
  };
}

beforeEach(() => _resetForTest());
afterEach(() => _resetForTest());

describe("findState", () => {
  it("setQuery updates and notifies", () => {
    const seen: string[] = [];
    subscribeQuery((q) => seen.push(q));
    setQuery("hello");
    expect(getQuery()).toBe("hello");
    expect(seen).toEqual(["hello"]);
  });

  it("registering a page anchors the current match to its first hit", () => {
    setQuery("foo");
    const a = makeAdapter(3, 2);
    registerPageAdapter(a);
    expect(getTotalMatches()).toBe(2);
    expect(getCurrentIndex()).toBe(1);
    expect(a.scrollSpy).toHaveBeenCalledWith(0);
  });

  it("matches across pages are ordered by page asc", () => {
    setQuery("foo");
    registerPageAdapter(makeAdapter(5, 2));
    registerPageAdapter(makeAdapter(2, 3));
    expect(getTotalMatches()).toBe(5);
    // First overall match is on page 2 (lowest page number).
    expect(getCurrentIndex()).toBe(1);
    next();
    expect(getCurrentIndex()).toBe(2);
    next();
    expect(getCurrentIndex()).toBe(3);
    next();
    expect(getCurrentIndex()).toBe(4); // crosses into page 5
  });

  it("next/prev cycles around the ends", () => {
    setQuery("foo");
    registerPageAdapter(makeAdapter(1, 2));
    expect(getCurrentIndex()).toBe(1);
    next();
    expect(getCurrentIndex()).toBe(2);
    next();
    expect(getCurrentIndex()).toBe(1); // wrapped to start
    prev();
    expect(getCurrentIndex()).toBe(2); // wrapped to end
  });

  it("unregisterPage advances current to next available page", () => {
    setQuery("foo");
    const p2 = makeAdapter(2, 1);
    const p5 = makeAdapter(5, 1);
    registerPageAdapter(p2);
    registerPageAdapter(p5);
    expect(getCurrentIndex()).toBe(1); // on page 2
    unregisterPage(2);
    expect(getTotalMatches()).toBe(1);
    expect(getCurrentIndex()).toBe(1); // now on page 5
    expect(p5.scrollSpy).toHaveBeenCalledWith(0);
  });

  it("clearing the query resets current and notifies subscribers", () => {
    setQuery("foo");
    registerPageAdapter(makeAdapter(1, 3));
    const seenMatches: number[] = [];
    subscribeMatches(() => seenMatches.push(getCurrentIndex()));
    setQuery("");
    expect(getCurrentIndex()).toBe(0);
    expect(seenMatches.length).toBeGreaterThan(0);
  });

  it("getTotalMatches is 0 when no pages registered", () => {
    setQuery("foo");
    expect(getTotalMatches()).toBe(0);
    expect(getCurrentIndex()).toBe(0);
    next(); // should be no-op
    expect(getCurrentIndex()).toBe(0);
  });
});
