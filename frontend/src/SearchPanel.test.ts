import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetForTest,
  buildSearchPanel,
  focusSearchInput,
  setActiveSearchDoc,
} from "./SearchPanel.ts";
import * as pageNav from "./pageNav.ts";

beforeEach(() => {
  _resetForTest();
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  _resetForTest();
});

/** Flush the debounce timer (setTimeout) + the fetch promise chain. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
  await Promise.resolve();
}

function stubFetch(
  results: Array<{ page: number; snippet: string }>,
): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (_url: string) => ({
    ok: true,
    json: async () => ({ doc_id: "abc", query: "x", results }),
  }));
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return fn;
}

describe("SearchPanel", () => {
  it("renders an input and the empty-state message", () => {
    const root = buildSearchPanel({ debounceMs: 0 });
    document.body.appendChild(root);
    expect(root.querySelector(".search-input")).toBeTruthy();
    expect(root.querySelector(".search-status")?.textContent).toBe(
      "Type to search.",
    );
    expect(root.querySelectorAll(".search-result").length).toBe(0);
  });

  it("renders results returned by /search with their page numbers", async () => {
    stubFetch([
      { page: 3, snippet: "the <mark>fox</mark> jumps" },
      { page: 7, snippet: "another <mark>fox</mark> here" },
    ]);
    setActiveSearchDoc("abc");

    const root = buildSearchPanel({ debounceMs: 0 });
    document.body.appendChild(root);
    const input = root.querySelector(".search-input") as HTMLInputElement;
    input.value = "fox";
    input.dispatchEvent(new Event("input"));

    await flush();

    const rows = root.querySelectorAll(".search-result");
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector(".search-result-page")?.textContent).toBe(
      "Page 3",
    );
    expect(rows[1].querySelector(".search-result-page")?.textContent).toBe(
      "Page 7",
    );
    expect(rows[0].querySelector("mark")?.textContent).toBe("fox");
  });

  it("clicking a result calls jumpToPage with the result's page", async () => {
    stubFetch([{ page: 12, snippet: "<mark>hit</mark>" }]);
    setActiveSearchDoc("abc");
    const spy = vi.spyOn(pageNav, "jumpToPage").mockImplementation(() => {});

    const root = buildSearchPanel({ debounceMs: 0 });
    document.body.appendChild(root);
    const input = root.querySelector(".search-input") as HTMLInputElement;
    input.value = "hit";
    input.dispatchEvent(new Event("input"));

    await flush();

    const row = root.querySelector(".search-result") as HTMLButtonElement;
    row.click();
    expect(spy).toHaveBeenCalledWith(12);
  });

  it("renders 'No matches' when results are empty", async () => {
    stubFetch([]);
    setActiveSearchDoc("abc");

    const root = buildSearchPanel({ debounceMs: 0 });
    document.body.appendChild(root);
    const input = root.querySelector(".search-input") as HTMLInputElement;
    input.value = "zzz";
    input.dispatchEvent(new Event("input"));
    await flush();

    expect(root.querySelector(".search-status")?.textContent).toBe(
      "No matches.",
    );
  });

  it("debounces input: 3 keystrokes within the window → 1 fetch", async () => {
    vi.useFakeTimers();
    const fetchFn = stubFetch([{ page: 1, snippet: "<mark>x</mark>" }]);
    setActiveSearchDoc("abc");

    const root = buildSearchPanel({ debounceMs: 200 });
    document.body.appendChild(root);
    const input = root.querySelector(".search-input") as HTMLInputElement;

    input.value = "f";
    input.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(50);
    input.value = "fo";
    input.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(50);
    input.value = "fox";
    input.dispatchEvent(new Event("input"));

    expect(fetchFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((fetchFn.mock.calls[0]?.[0] as string).includes("q=fox")).toBe(true);
  });

  it("focusSearchInput focuses the panel's input", () => {
    const root = buildSearchPanel({ debounceMs: 0 });
    document.body.appendChild(root);
    const input = root.querySelector(".search-input") as HTMLInputElement;
    expect(document.activeElement).not.toBe(input);
    focusSearchInput();
    expect(document.activeElement).toBe(input);
  });

  it("shows 'Open a document' when no doc is active", async () => {
    stubFetch([]);
    setActiveSearchDoc(null);

    const root = buildSearchPanel({ debounceMs: 0 });
    document.body.appendChild(root);
    const input = root.querySelector(".search-input") as HTMLInputElement;
    input.value = "anything";
    input.dispatchEvent(new Event("input"));
    await flush();

    expect(root.querySelector(".search-status")?.textContent).toBe(
      "Open a document to search.",
    );
  });

  it("snippet rendering does not interpret HTML in untrusted text", async () => {
    // If the source PDF contained literal "<img>" or "<script>", the FTS5
    // snippet() output would pass it through verbatim. We build text nodes
    // ourselves so it stays as text, not HTML.
    stubFetch([{ page: 1, snippet: "before<mark>X</mark><img src=x>after" }]);
    setActiveSearchDoc("abc");

    const root = buildSearchPanel({ debounceMs: 0 });
    document.body.appendChild(root);
    const input = root.querySelector(".search-input") as HTMLInputElement;
    input.value = "x";
    input.dispatchEvent(new Event("input"));
    await flush();

    const snip = root.querySelector(".search-result-snippet")!;
    expect(snip.querySelectorAll("img").length).toBe(0);
    expect(snip.textContent).toBe("beforeX<img src=x>after");
  });
});
