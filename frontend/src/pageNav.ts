/**
 * Doc-level page navigation state. Decouples the toolbar widget (always
 * present) from the per-document PageList (created on each doc open).
 *
 *   main.ts        : on doc open → setActivePageList(handle); on close → setActivePageList(null)
 *   PageIndicator  : subscribePageInfo + jumpToPage
 */

import type { PageListHandle } from "./viewer/PageList.ts";

export interface PageInfo {
  current: number;
  total: number;
}

let active: PageListHandle | null = null;
let unsubCurrent: (() => void) | null = null;
const subs = new Set<(info: PageInfo | null) => void>();

export function setActivePageList(
  handle: PageListHandle | null,
  total = 0,
): void {
  unsubCurrent?.();
  unsubCurrent = null;
  active = handle;

  if (!handle) {
    emit(null);
    return;
  }

  const initial: PageInfo = { current: handle.getCurrentPage(), total };
  emit(initial);
  unsubCurrent = handle.subscribeCurrentPage((current) => {
    emit({ current, total });
  });
}

export function jumpToPage(page: number): void {
  if (!active) return;
  active.scrollToPage(page);
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
}
