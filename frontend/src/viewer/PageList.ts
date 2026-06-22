/**
 * Virtualized page list (Phase 2).
 *
 * Mounts every page as a correctly-sized placeholder div so the scrollbar is
 * honest from the first frame. An IntersectionObserver upgrades placeholders
 * to real `PageView`s when they enter a buffer zone around the viewport, and
 * demotes them back to placeholders when they leave.
 *
 * A second observer tracks which page is most visible in the viewport so a
 * page-number indicator can subscribe to that.
 *
 * Scrollable container is owned by the caller (`#viewer` in `main.ts`); we
 * append slots into a `<div class="page-list">` that lives inside it.
 */

import type { DocumentMeta, PageDimension } from "../api.ts";
import { getBaseScale, subscribeFit } from "../fit.ts";
import { getRotation, subscribeRotation } from "../rotation.ts";
import { getZoom, subscribeZoom } from "../zoom.ts";
import { buildPageView, type PageViewHandle } from "./PageView.ts";

interface Slot {
  index: number; // zero-based
  dim: PageDimension;
  element: HTMLElement;
  handle: PageViewHandle | null;
  filled: boolean;
}

export interface PageListHandle {
  element: HTMLElement;
  dispose: () => void;
  scrollToPage: (page: number) => void;
  /** 1-indexed page that's most visible right now. */
  getCurrentPage: () => number;
  subscribeCurrentPage: (cb: (page: number) => void) => () => void;
}

const RENDER_BUFFER_VIEWPORTS = 1; // upgrade pages within ±N viewport heights

export function buildPageList(
  meta: DocumentMeta,
  dims: PageDimension[],
  scrollContainer: HTMLElement,
): PageListHandle {
  const root = document.createElement("div");
  root.className = "page-list";

  const slots: Slot[] = dims.map((dim, i) => {
    const el = createPlaceholder(dim, i + 1, meta.page_count);
    return { index: i, dim, element: el, handle: null, filled: false };
  });
  for (const s of slots) root.appendChild(s.element);

  sizeAllPlaceholders(slots);

  let currentPage = 1;
  const currentSubs = new Set<(p: number) => void>();
  const ratios = new Map<number, number>();

  const upgradeObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const idx = Number((entry.target as HTMLElement).dataset.pageIndex);
        const slot = slots[idx];
        if (!slot) continue;
        if (entry.isIntersecting) upgrade(slot, meta, reobserve);
        else demote(slot, meta, reobserve);
      }
    },
    {
      root: scrollContainer,
      rootMargin: `${RENDER_BUFFER_VIEWPORTS * 100}% 0px`,
      threshold: 0,
    },
  );

  const visibilityObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const idx = Number((entry.target as HTMLElement).dataset.pageIndex);
        ratios.set(idx, entry.intersectionRatio);
      }
      const best = pickCurrentPage(ratios, slots.length);
      if (best !== currentPage) {
        currentPage = best;
        for (const cb of currentSubs) cb(currentPage);
      }
    },
    {
      root: scrollContainer,
      threshold: [0, 0.01, 0.25, 0.5, 0.75, 1.0],
    },
  );

  // Re-attach both observers when a swap replaces the slot element.
  const reobserve = (oldEl: HTMLElement, newEl: HTMLElement) => {
    upgradeObserver.unobserve(oldEl);
    visibilityObserver.unobserve(oldEl);
    upgradeObserver.observe(newEl);
    visibilityObserver.observe(newEl);
  };

  for (const s of slots) {
    upgradeObserver.observe(s.element);
    visibilityObserver.observe(s.element);
  }

  // --- Resize / zoom: re-size every placeholder & re-layout filled views ---
  const handleResize = () => sizeAllPlaceholders(slots);
  const unsubFit = subscribeFit(handleResize);
  const unsubZoom = subscribeZoom(handleResize);
  const unsubRotation = subscribeRotation(handleResize);

  const scrollToPage = (page: number) => {
    const slot = slots[page - 1];
    if (!slot) return;
    slot.element.scrollIntoView({ block: "start", behavior: "auto" });
  };

  return {
    element: root,
    dispose: () => {
      upgradeObserver.disconnect();
      visibilityObserver.disconnect();
      unsubFit();
      unsubZoom();
      unsubRotation();
      for (const s of slots) {
        if (s.handle) s.handle.dispose();
      }
      currentSubs.clear();
    },
    scrollToPage,
    getCurrentPage: () => currentPage,
    subscribeCurrentPage: (cb) => {
      currentSubs.add(cb);
      return () => {
        currentSubs.delete(cb);
      };
    },
  };
}

function createPlaceholder(
  _dim: PageDimension,
  pageNumber: number,
  pageCount: number,
): HTMLElement {
  const el = document.createElement("div");
  el.className = "page-wrap page-placeholder";
  el.dataset.pageIndex = String(pageNumber - 1);
  el.dataset.pageNumber = String(pageNumber);

  const num = document.createElement("div");
  num.className = "page-number";
  num.textContent = `Page ${pageNumber} of ${pageCount}`;
  el.appendChild(num);

  return el;
}

/** On-screen page size after rotation: 90°/270° swap width and height. */
function visualPageSize(dim: PageDimension, scale: number): [number, number] {
  const w = dim.width_pt * scale;
  const h = dim.height_pt * scale;
  const rot = getRotation();
  return rot === 90 || rot === 270 ? [h, w] : [w, h];
}

function sizeAllPlaceholders(slots: Slot[]): void {
  const scale = getBaseScale() * getZoom();
  for (const s of slots) {
    const [w, h] = visualPageSize(s.dim, scale);
    s.element.style.width = `${w}px`;
    s.element.style.height = `${h}px`;
  }
}

type Reobserve = (oldEl: HTMLElement, newEl: HTMLElement) => void;

function upgrade(slot: Slot, meta: DocumentMeta, reobserve: Reobserve): void {
  if (slot.filled) return;
  const handle = buildPageView(meta, slot.index + 1, slot.dim);
  handle.element.dataset.pageIndex = String(slot.index);
  handle.element.dataset.pageNumber = String(slot.index + 1);
  const old = slot.element;
  old.replaceWith(handle.element);
  slot.element = handle.element;
  slot.handle = handle;
  slot.filled = true;
  reobserve(old, handle.element);
}

function demote(slot: Slot, meta: DocumentMeta, reobserve: Reobserve): void {
  if (!slot.filled) return;
  slot.handle?.dispose();
  slot.handle = null;
  slot.filled = false;
  const fresh = createPlaceholder(slot.dim, slot.index + 1, meta.page_count);
  const scale = getBaseScale() * getZoom();
  const [w, h] = visualPageSize(slot.dim, scale);
  fresh.style.width = `${w}px`;
  fresh.style.height = `${h}px`;
  const old = slot.element;
  old.replaceWith(fresh);
  slot.element = fresh;
  reobserve(old, fresh);
}

/** Exposed for tests. Highest intersection ratio wins; ties go to lower page. */
export function pickCurrentPage(
  ratios: Map<number, number>,
  pageCount: number,
): number {
  let bestIdx = 0;
  let bestRatio = -1;
  for (let i = 0; i < pageCount; i++) {
    const r = ratios.get(i) ?? 0;
    if (r > bestRatio) {
      bestRatio = r;
      bestIdx = i;
    }
  }
  return bestIdx + 1;
}
