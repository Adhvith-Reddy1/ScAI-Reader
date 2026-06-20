/**
 * Floating find-in-page bar (Chrome / Edge style). Mounted once in main.ts;
 * shown via `show()` (typically bound to Cmd-F), hidden via `hide()` (Esc or
 * the close button). Reads/writes [[findState]].
 *
 *   [ input ]  3/27  [<] [>] [×]
 */

import {
  clearQuery,
  getCurrentIndex,
  getQuery,
  getTotalMatches,
  next as findNext,
  prev as findPrev,
  setQuery,
  subscribeMatches,
  subscribeQuery,
} from "./findState.ts";

export interface FindBarHandle {
  element: HTMLElement;
  show(): void;
  hide(): void;
  isOpen(): boolean;
  focusInput(): void;
}

const DEBOUNCE_MS = 100;

export function buildFindBar(): FindBarHandle {
  const root = document.createElement("div");
  root.className = "find-bar";
  root.hidden = true;

  const input = document.createElement("input");
  input.type = "search";
  input.className = "find-bar-input";
  input.placeholder = "Find on page";
  input.setAttribute("aria-label", "Find on page");

  const count = document.createElement("span");
  count.className = "find-bar-count";

  const prev = makeBtn("‹", "Previous match", () => findPrev());
  prev.classList.add("find-bar-step");
  const nxt = makeBtn("›", "Next match", () => findNext());
  nxt.classList.add("find-bar-step");
  const close = makeBtn("×", "Close", () => hide());
  close.classList.add("find-bar-close");

  root.append(input, count, prev, nxt, close);

  // --- input → query (debounced) ---------------------------------------
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  input.addEventListener("input", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      setQuery(input.value);
      debounceTimer = null;
    }, DEBOUNCE_MS);
  });

  // --- enter / shift-enter to navigate --------------------------------
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        setQuery(input.value);
        debounceTimer = null;
      }
      if (e.shiftKey) findPrev();
      else findNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      hide();
    }
  });

  // --- count rendering -------------------------------------------------
  const renderCount = (): void => {
    const total = getTotalMatches();
    const cur = getCurrentIndex();
    if (!getQuery()) {
      count.textContent = "";
    } else if (total === 0) {
      count.textContent = "No results";
    } else {
      count.textContent = `${cur || 0} / ${total}`;
    }
  };
  renderCount();
  subscribeMatches(renderCount);
  subscribeQuery(renderCount);

  // --- public API ------------------------------------------------------
  const show = (): void => {
    root.hidden = false;
    input.focus();
    input.select();
  };
  const hide = (): void => {
    root.hidden = true;
    // Clear so leftover highlights aren't confusing on next open.
    input.value = "";
    clearQuery();
  };

  return {
    element: root,
    show,
    hide,
    isOpen: () => !root.hidden,
    focusInput: () => input.focus(),
  };
}

function makeBtn(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", onClick);
  return b;
}
