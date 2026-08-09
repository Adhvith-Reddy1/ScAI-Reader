/**
 * Shared "resizable, capped-height panel" behavior used by both the pinned
 * explanation/definition tooltip (ExplanationTooltip.ts) and the figure
 * interpretation card (FigureCard.ts).
 *
 * A ResizablePanel:
 *  - builds the eight resize handles (n/s/e/w/ne/nw/se/sw) and appends them
 *    to the panel element, wired to drag-to-resize;
 *  - remembers the reader's chosen {width, height} in localStorage under a
 *    caller-supplied key, so each panel persists its own size independently;
 *  - tracks whether the panel has already been positioned/sized for the
 *    current "open" session, so re-renders (e.g. new chat messages arriving)
 *    don't yank a size/position the reader just set — only an explicit
 *    reset() (call this when the panel closes) clears that.
 *
 * This module owns *sizing* only. Anchoring a panel near its trigger element
 * (a highlight, a figure) stays with each caller, since that logic differs
 * between them.
 */

const DIRECTIONS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;

const DEFAULT_MIN_WIDTH = 260;
const DEFAULT_MIN_HEIGHT = 200;
// Keep the panel from being dragged larger than the viewport.
const VIEWPORT_MARGIN_PX = 24;

export interface PanelSize {
  width: number;
  height: number;
}

export interface ResizablePanelInit {
  /** The panel element resize handles attach to and that gets resized. */
  el: HTMLElement;
  /** localStorage key this instance's size is persisted/loaded under. */
  storageKey: string;
  /** Fallback dimensions used until the reader has resized (or dragged) it. */
  defaultWidth: number;
  defaultHeight: number;
  minWidth?: number;
  minHeight?: number;
}

export class ResizablePanel {
  private readonly el: HTMLElement;
  private readonly storageKey: string;
  private readonly minWidth: number;
  private readonly minHeight: number;
  private currentSize: PanelSize;
  private placedForSession = false;

  constructor(init: ResizablePanelInit) {
    this.el = init.el;
    this.storageKey = init.storageKey;
    this.minWidth = init.minWidth ?? DEFAULT_MIN_WIDTH;
    this.minHeight = init.minHeight ?? DEFAULT_MIN_HEIGHT;
    this.currentSize = loadSavedSize(this.storageKey) ?? {
      width: init.defaultWidth,
      height: init.defaultHeight,
    };
    for (const dir of DIRECTIONS) {
      const handle = document.createElement("div");
      handle.className = `explanation-resize-handle resize-${dir}`;
      handle.addEventListener("pointerdown", (ev) => this.startResize(dir, ev));
      this.el.appendChild(handle);
    }
  }

  /** The reader's remembered (or default) size for this panel. */
  get size(): PanelSize {
    return this.currentSize;
  }

  /**
   * Whether the panel has already been positioned/sized for the current open
   * session — once true, callers should leave its geometry alone (beyond
   * clamping) until reset() is called.
   */
  get placed(): boolean {
    return this.placedForSession;
  }

  /** Mark the panel as positioned for this open session. */
  markPlaced(): void {
    this.placedForSession = true;
  }

  /**
   * Call when the panel closes so the next open re-anchors from scratch —
   * the remembered size itself (currentSize) is untouched and is re-applied
   * then.
   */
  reset(): void {
    this.placedForSession = false;
  }

  /** Drag a resize handle to size the panel; content reflows to fit. */
  private startResize(dir: string, e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const el = this.el;
    const startX = e.clientX;
    const startY = e.clientY;
    const rect = el.getBoundingClientRect();
    const startW = rect.width;
    const startH = rect.height;
    const startLeft = parseFloat(el.style.left) || rect.left + window.scrollX;
    const startTop = parseFloat(el.style.top) || rect.top + window.scrollY;
    const maxW = window.innerWidth - VIEWPORT_MARGIN_PX;
    const maxH = window.innerHeight - VIEWPORT_MARGIN_PX;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let w = startW;
      let h = startH;
      if (dir.includes("e")) w = startW + dx;
      if (dir.includes("w")) w = startW - dx;
      if (dir.includes("s")) h = startH + dy;
      if (dir.includes("n")) h = startH - dy;
      w = Math.max(this.minWidth, Math.min(maxW, w));
      h = Math.max(this.minHeight, Math.min(maxH, h));
      // Dragging a west/north edge keeps the opposite edge anchored.
      const left = dir.includes("w") ? startLeft + (startW - w) : startLeft;
      const top = dir.includes("n") ? startTop + (startH - h) : startTop;

      el.style.width = `${w}px`;
      // Set height AND max-height together so the drag can grow the panel
      // past the placement cap; the dragged height becomes the new cap.
      el.style.height = `${h}px`;
      el.style.maxHeight = `${h}px`;
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      this.placedForSession = true;
      this.currentSize = { width: w, height: h };
      persistSavedSize(this.storageKey, this.currentSize);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
}

function loadSavedSize(key: string): PanelSize | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (typeof o?.width === "number" && typeof o?.height === "number") {
      return { width: o.width, height: o.height };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function persistSavedSize(key: string, size: PanelSize): void {
  try {
    localStorage.setItem(key, JSON.stringify(size));
  } catch {
    /* ignore */
  }
}
