/**
 * Hover actions for highlights — currently a single "Delete" button that
 * pops up when the cursor rests on any highlight.
 *
 * Like the explanation tooltip, this can't rely on `mouseenter` against the
 * SVG annotation group: the invisible text-layer overlays it so selection
 * works, and that swallows pointer events. So we hit-test the cursor against
 * each registered highlight's rects via a single page-wrap `mousemove`.
 */

const GAP_PX = 6;

let boxEl: HTMLDivElement | null = null;
let deleteBtn: HTMLButtonElement | null = null;
let activeId: string | null = null;
let pendingId: string | null = null;
let hideTimer: number | null = null;
let onDeleteActive: ((id: string) => void) | null = null;

interface Registration {
  group: SVGGElement;
  annotationId: string;
  onDelete: (id: string) => void;
}

interface WrapState {
  registrations: Map<string, Registration>;
  onMove: (e: MouseEvent) => void;
  onLeave: () => void;
}

const wrapStates = new WeakMap<HTMLElement, WrapState>();

function ensureBox(): HTMLDivElement {
  if (boxEl) return boxEl;
  const el = document.createElement("div");
  el.className = "highlight-actions";
  el.style.display = "none";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "highlight-actions-delete";
  btn.setAttribute("aria-label", "Delete highlight");
  btn.textContent = "Delete";
  btn.addEventListener("click", () => {
    if (activeId && onDeleteActive) onDeleteActive(activeId);
    hide();
  });
  el.appendChild(btn);

  el.addEventListener("mouseenter", () => {
    if (hideTimer != null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  });
  el.addEventListener("mouseleave", () => scheduleHide());

  document.body.appendChild(el);
  boxEl = el;
  deleteBtn = btn;
  return el;
}

function hide(): void {
  if (hideTimer != null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
  activeId = null;
  onDeleteActive = null;
  if (boxEl) boxEl.style.display = "none";
}

function scheduleHide(): void {
  if (hideTimer != null) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (pendingId == null && !boxEl?.matches(":hover")) hide();
  }, 120);
}

function position(anchorRect: DOMRect): void {
  const el = ensureBox();
  el.style.display = "block";
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const margin = 6;

  // Top-right corner of the highlight, nudged just above it.
  let x = anchorRect.right - w;
  x = Math.max(margin, Math.min(x, window.innerWidth - w - margin));
  let y = anchorRect.top - h - GAP_PX;
  if (y < margin) y = anchorRect.bottom + GAP_PX;

  el.style.left = `${x + window.scrollX}px`;
  el.style.top = `${y + window.scrollY}px`;
}

function pointInRect(x: number, y: number, r: DOMRect): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function findHit(state: WrapState, x: number, y: number): Registration | null {
  for (const reg of state.registrations.values()) {
    for (const rect of reg.group.querySelectorAll("rect")) {
      if (pointInRect(x, y, rect.getBoundingClientRect())) return reg;
    }
  }
  return null;
}

function show(reg: Registration): void {
  activeId = reg.annotationId;
  onDeleteActive = reg.onDelete;
  if (deleteBtn) deleteBtn.disabled = false;
  position(reg.group.getBoundingClientRect());
}

function setupWrapListeners(wrap: HTMLElement): WrapState {
  const onMove = (e: MouseEvent) => {
    const state = wrapStates.get(wrap);
    if (!state) return;
    const hit = findHit(state, e.clientX, e.clientY);
    const hitId = hit?.annotationId ?? null;
    if (hitId === pendingId) return;
    pendingId = hitId;

    if (hit) {
      if (hideTimer != null) {
        window.clearTimeout(hideTimer);
        hideTimer = null;
      }
      show(hit);
    } else if (activeId != null) {
      scheduleHide();
    }
  };

  const onLeave = () => {
    pendingId = null;
    if (activeId != null) scheduleHide();
  };

  wrap.addEventListener("mousemove", onMove);
  wrap.addEventListener("mouseleave", onLeave);
  return { registrations: new Map(), onMove, onLeave };
}

/**
 * Register a highlight so hovering it surfaces the delete button. Returns a
 * cleanup function. Mirrors the deferred-attach trick the explanation tooltip
 * uses: the SVG group isn't in the DOM yet when this is called.
 */
export function bindHighlightActions(
  group: SVGGElement,
  annotationId: string,
  onDelete: (id: string) => void,
): () => void {
  let cancelled = false;
  let resolvedCleanup: (() => void) | null = null;

  queueMicrotask(() => {
    if (cancelled) return;
    const wrap = group.closest<HTMLElement>(".page-wrap");
    if (!wrap) return;

    let state = wrapStates.get(wrap);
    if (!state) {
      state = setupWrapListeners(wrap);
      wrapStates.set(wrap, state);
    }
    state.registrations.set(annotationId, { group, annotationId, onDelete });

    resolvedCleanup = () => {
      const s = wrapStates.get(wrap);
      if (!s) return;
      s.registrations.delete(annotationId);
      if (activeId === annotationId) hide();
      if (pendingId === annotationId) pendingId = null;
      if (s.registrations.size === 0) {
        wrap.removeEventListener("mousemove", s.onMove);
        wrap.removeEventListener("mouseleave", s.onLeave);
        wrapStates.delete(wrap);
      }
    };
  });

  return () => {
    cancelled = true;
    if (resolvedCleanup) resolvedCleanup();
  };
}
