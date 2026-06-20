/**
 * Toolbar widget: [ N ] / Total
 *
 * The number input is editable; Enter (or blur) commits a jump via
 * [[pageNav]]. The displayed value tracks the active document's current
 * page until the user starts typing.
 */

import { jumpToPage, subscribePageInfo, type PageInfo } from "./pageNav.ts";

export function buildPageIndicator(): HTMLElement {
  const root = document.createElement("div");
  root.className = "page-indicator";
  root.hidden = true;

  const input = document.createElement("input");
  input.type = "number";
  input.className = "page-indicator-input";
  input.min = "1";
  input.step = "1";
  input.setAttribute("aria-label", "Jump to page");

  const separator = document.createElement("span");
  separator.className = "page-indicator-sep";
  separator.textContent = "/";

  const total = document.createElement("span");
  total.className = "page-indicator-total";

  root.append(input, separator, total);

  let editing = false;
  let cancelNext = false;
  let last: PageInfo | null = null;

  input.addEventListener("focus", () => {
    editing = true;
    input.select();
  });

  const commit = (): void => {
    editing = false;
    if (cancelNext) {
      cancelNext = false;
      if (last) input.value = String(last.current);
      return;
    }
    const v = parseInt(input.value, 10);
    if (!last || isNaN(v)) {
      if (last) input.value = String(last.current);
      return;
    }
    const clamped = Math.max(1, Math.min(last.total, v));
    input.value = String(clamped);
    jumpToPage(clamped);
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      input.blur();
    } else if (e.key === "Escape") {
      cancelNext = true;
      input.blur();
    }
  });

  const render = (info: PageInfo | null): void => {
    last = info;
    if (!info) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    total.textContent = String(info.total);
    input.max = String(info.total);
    if (!editing) input.value = String(info.current);
  };

  subscribePageInfo(render);
  return root;
}
