import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFindBar } from "./FindBar.ts";
import {
  _resetForTest,
  getQuery,
  registerPageAdapter,
} from "./findState.ts";

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTest();
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
  _resetForTest();
  document.body.innerHTML = "";
});

describe("FindBar", () => {
  it("starts hidden; show() reveals and focuses the input", () => {
    const bar = buildFindBar();
    document.body.appendChild(bar.element);
    expect(bar.element.hidden).toBe(true);
    bar.show();
    expect(bar.element.hidden).toBe(false);
    expect(document.activeElement).toBe(
      bar.element.querySelector(".find-bar-input"),
    );
  });

  it("debounced input → setQuery", () => {
    const bar = buildFindBar();
    document.body.appendChild(bar.element);
    bar.show();
    const input = bar.element.querySelector(".find-bar-input") as HTMLInputElement;
    input.value = "hello";
    input.dispatchEvent(new Event("input"));
    expect(getQuery()).toBe(""); // not yet
    vi.advanceTimersByTime(150);
    expect(getQuery()).toBe("hello");
  });

  it("Enter advances to the next match (production flow: type → debounce → register → enter)", () => {
    const bar = buildFindBar();
    document.body.appendChild(bar.element);
    bar.show();
    const input = bar.element.querySelector(".find-bar-input") as HTMLInputElement;

    input.value = "foo";
    input.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(150); // debounce → setQuery, PageViews would now re-find

    registerPageAdapter({
      page: 1,
      count: 2,
      scrollToMatchAndMark: vi.fn(),
      clearActiveMark: vi.fn(),
    });
    // After registration, anchored to match #1.
    expect(getQuery()).toBe("foo");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    const count = bar.element.querySelector(".find-bar-count") as HTMLElement;
    expect(count.textContent).toBe("2 / 2");
  });

  it("Escape hides and clears the query", () => {
    const bar = buildFindBar();
    document.body.appendChild(bar.element);
    bar.show();
    const input = bar.element.querySelector(".find-bar-input") as HTMLInputElement;
    input.value = "x";
    input.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(150);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(bar.element.hidden).toBe(true);
    expect(getQuery()).toBe("");
  });

  it("renders count as N / Total when there are matches", () => {
    const bar = buildFindBar();
    document.body.appendChild(bar.element);
    bar.show();
    const input = bar.element.querySelector(".find-bar-input") as HTMLInputElement;
    input.value = "foo";
    input.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(150);
    registerPageAdapter({
      page: 1,
      count: 3,
      scrollToMatchAndMark: vi.fn(),
      clearActiveMark: vi.fn(),
    });
    const count = bar.element.querySelector(".find-bar-count") as HTMLElement;
    expect(count.textContent).toBe("1 / 3");
  });

  it("shows 'No results' when query exists but no pages have matches", () => {
    const bar = buildFindBar();
    document.body.appendChild(bar.element);
    bar.show();
    const input = bar.element.querySelector(".find-bar-input") as HTMLInputElement;
    input.value = "foo";
    input.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(150);
    const count = bar.element.querySelector(".find-bar-count") as HTMLElement;
    expect(count.textContent).toBe("No results");
  });
});
