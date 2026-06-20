import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetForTest as resetFit,
  setDocumentBounds,
  setViewport,
} from "../fit.ts";
import { _resetForTest as resetZoom } from "../zoom.ts";
import type { DocumentMeta, PageDimension } from "../api.ts";
import { buildPageList, pickCurrentPage } from "./PageList.ts";

// jsdom doesn't ship IntersectionObserver; install a hand-driven stub before
// importing PageList so the constructor reference resolves.
interface FakeEntry {
  target: Element;
  isIntersecting: boolean;
  intersectionRatio: number;
}
type FakeCallback = (entries: FakeEntry[]) => void;
const observers: FakeIntersectionObserver[] = [];

class FakeIntersectionObserver {
  callback: FakeCallback;
  options: IntersectionObserverInit | undefined;
  targets = new Set<Element>();
  constructor(cb: FakeCallback, options?: IntersectionObserverInit) {
    this.callback = cb;
    this.options = options;
    observers.push(this);
  }
  observe(el: Element): void {
    this.targets.add(el);
  }
  unobserve(el: Element): void {
    this.targets.delete(el);
  }
  disconnect(): void {
    this.targets.clear();
  }
  /** Test helper: fire a synthetic batch of entries. */
  emit(entries: FakeEntry[]): void {
    this.callback(entries.filter((e) => this.targets.has(e.target)));
  }
}

beforeEach(() => {
  observers.length = 0;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
    FakeIntersectionObserver;
});

afterEach(() => {
  resetFit();
  resetZoom();
  vi.restoreAllMocks();
});

const meta: DocumentMeta = {
  id: "doc1",
  filename: "x.pdf",
  page_count: 5,
  title: null,
  author: null,
};

const dims: PageDimension[] = Array.from({ length: 5 }, (_, i) => ({
  page: i + 1,
  width_pt: 600,
  height_pt: 800,
}));

describe("pickCurrentPage (pure)", () => {
  it("picks the page with the highest intersection ratio", async () => {
    
    const ratios = new Map([
      [0, 0.2],
      [1, 0.8],
      [2, 0.5],
    ]);
    expect(pickCurrentPage(ratios, 5)).toBe(2);
  });

  it("returns page 1 when nothing is visible", async () => {
    
    expect(pickCurrentPage(new Map(), 5)).toBe(1);
  });

  it("ties go to the lower page index", async () => {
    
    const ratios = new Map([
      [2, 0.5],
      [3, 0.5],
    ]);
    expect(pickCurrentPage(ratios, 5)).toBe(3);
  });
});

describe("buildPageList placeholder layout", () => {
  it("mounts one placeholder per page with the correct size", async () => {
    
    setDocumentBounds(600, 800);
    setViewport(1200, 900);

    const scroll = document.createElement("div");
    document.body.appendChild(scroll);
    const handle = buildPageList(meta, dims, scroll);
    scroll.appendChild(handle.element);

    const placeholders = handle.element.querySelectorAll(".page-placeholder");
    expect(placeholders.length).toBe(5);
    const first = placeholders[0] as HTMLElement;
    // fit-width: scale = (1200 - 48) / 600 = 1.92; width = 600 * 1.92 = 1152
    expect(first.style.width).toBe("1152px");
    expect(first.style.height).toBe(`${800 * 1.92}px`);
    handle.dispose();
  });
});

describe("buildPageList upgrade/demote on intersection", () => {
  it("replaces placeholder with a page-wrap when intersecting", async () => {
    
    setDocumentBounds(600, 800);
    setViewport(1200, 900);
    const scroll = document.createElement("div");
    document.body.appendChild(scroll);
    const handle = buildPageList(meta, dims, scroll);
    scroll.appendChild(handle.element);

    const upgradeObserver = observers[0];
    const placeholder = handle.element.children[0] as HTMLElement;
    upgradeObserver.emit([
      { target: placeholder, isIntersecting: true, intersectionRatio: 1 },
    ]);

    const swapped = handle.element.children[0] as HTMLElement;
    expect(swapped.classList.contains("page-placeholder")).toBe(false);
    expect(swapped.classList.contains("page-wrap")).toBe(true);
    handle.dispose();
  });

  it("notifies current-page subscribers when visibility ratio changes", async () => {
    
    setDocumentBounds(600, 800);
    setViewport(1200, 900);
    const scroll = document.createElement("div");
    document.body.appendChild(scroll);
    const handle = buildPageList(meta, dims, scroll);
    scroll.appendChild(handle.element);

    const seen: number[] = [];
    handle.subscribeCurrentPage((p) => seen.push(p));

    const visibility = observers[1];
    const placeholders = Array.from(handle.element.children) as HTMLElement[];
    visibility.emit([
      { target: placeholders[2], isIntersecting: true, intersectionRatio: 0.9 },
      { target: placeholders[1], isIntersecting: true, intersectionRatio: 0.1 },
    ]);
    expect(seen[seen.length - 1]).toBe(3);
    handle.dispose();
  });
});
