/**
 * Doc-level page navigation state. Decouples the toolbar widget (always
 * present) from the per-document PageList (created on each doc open).
 *
 *   main.ts        : on doc open → setActivePageList(handle); on close → setActivePageList(null)
 *   PageIndicator  : subscribePageInfo + jumpToPage
 */

import type { PageListHandle } from "./viewer/PageList.ts";

export interface PageInfo {
  doc_id: string;
  current: number;
  total: number;
}

let active: PageListHandle | null = null;
let unsubCurrent: (() => void) | null = null;
const subs = new Set<(info: PageInfo | null) => void>();

export function setActivePageList(
  handle: PageListHandle | null,
  total = 0,
  doc_id = "",
): void {
  unsubCurrent?.();
  unsubCurrent = null;
  active = handle;

  if (!handle) {
    emit(null);
    return;
  }

  const initial: PageInfo = { doc_id, current: handle.getCurrentPage(), total };
  emit(initial);
  unsubCurrent = handle.subscribeCurrentPage((current) => {
    emit({ doc_id, current, total });
  });
}

export function jumpToPage(page: number): void {
  if (!active) return;
  active.scrollToPage(page);
}

// How long to keep retrying for the annotation's rendered element after a
// jump: the target page may still be a placeholder (virtualized) and needs a
// beat to upgrade to a real PageView with its annotation layer attached.
const JUMP_POLL_MS = 150;
const JUMP_POLL_ATTEMPTS = 12; // ~1.8s ceiling
let jumpPollTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Jump to a specific highlight: scroll to its page (same as `jumpToPage`),
 * then poll briefly for its rendered `<g data-annotation-id>` — the page may
 * still be an unrendered placeholder right after the scroll — and once found,
 * center it in view and flash it so the reader's eye finds it.
 */
export function jumpToAnnotation(page: number, annotationId: string): void {
  if (!active) return;
  active.scrollToPage(page);
  if (jumpPollTimer != null) {
    clearTimeout(jumpPollTimer);
    jumpPollTimer = null;
  }
  pollForAnnotation(annotationId, JUMP_POLL_ATTEMPTS);
}

function pollForAnnotation(annotationId: string, attemptsLeft: number): void {
  jumpPollTimer = null;
  if (!active) return;
  // Not `CSS.escape` — jsdom (our test environment) doesn't implement it, and
  // annotation ids are client-minted UUIDs, so a quote/backslash escape is
  // all an attribute-selector value here ever needs.
  const escaped = annotationId.replace(/["\\]/g, "\\$&");
  const target = active.element.querySelector<SVGGElement>(
    `[data-annotation-id="${escaped}"]`,
  );
  if (target) {
    target.scrollIntoView({ block: "center", behavior: "auto" });
    target.classList.add("annotation-jump-flash");
    setTimeout(() => target.classList.remove("annotation-jump-flash"), 1200);
    return;
  }
  if (attemptsLeft <= 0) return;
  jumpPollTimer = setTimeout(
    () => pollForAnnotation(annotationId, attemptsLeft - 1),
    JUMP_POLL_MS,
  );
}

export function subscribePageInfo(
  cb: (info: PageInfo | null) => void,
): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

function emit(info: PageInfo | null): void {
  for (const cb of subs) cb(info);
}

/** For tests. */
export function _resetForTest(): void {
  unsubCurrent?.();
  unsubCurrent = null;
  active = null;
  subs.clear();
  if (jumpPollTimer != null) {
    clearTimeout(jumpPollTimer);
    jumpPollTimer = null;
  }
}
