/**
 * Keep text selection from bleeding across column boundaries while preserving
 * the mousedown anchor (where the user originally clicked).
 *
 * The previous implementation rebuilt the Range with `setStart`/`setEnd`,
 * which loses the anchor/focus distinction. Result: a backward drag (start
 * the selection in the right column, drag up-left) had its anchor relocated
 * to the start of the right column, which felt broken to the user.
 *
 * We now use `Selection.setBaseAndExtent` — it respects anchor (base) and
 * focus (extent) — so the anchor stays exactly where the user clicked, and
 * only the focus gets clipped to the column's nearest edge depending on
 * drag direction.
 */

let startCol: Element | null = null;
let installed = false;
let adjusting = false;

export function installColumnConstraint(wrap: HTMLElement): void {
  wrap.addEventListener("mousedown", (e) => {
    const target = e.target as Element | null;
    startCol = target?.closest(".text-column") ?? null;
  });
  if (!installed) {
    document.addEventListener("selectionchange", handleSelectionChange);
    installed = true;
  }
}

export function _resetForTest(): void {
  startCol = null;
}

function handleSelectionChange(): void {
  if (adjusting) return;
  if (!startCol || !startCol.isConnected) return;

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  if (!sel.anchorNode || !sel.focusNode) return;

  // The constraint only kicks in when the anchor (mousedown point) is in the
  // tracked startCol. If the user clicked outside any column to begin with,
  // leave selection alone.
  if (columnOf(sel.anchorNode) !== startCol) return;
  if (columnOf(sel.focusNode) === startCol) return;

  const clamp = clampFocusToColumn(sel.anchorNode, sel.focusNode, startCol);
  if (!clamp) return;

  adjusting = true;
  try {
    sel.setBaseAndExtent(
      sel.anchorNode,
      sel.anchorOffset,
      clamp.node,
      clamp.offset,
    );
  } finally {
    adjusting = false;
  }
}

export function columnOf(node: Node | null): Element | null {
  if (!node) return null;
  const el = node instanceof Element ? node : node.parentElement;
  return el?.closest?.(".text-column") ?? null;
}

/**
 * Choose a clipped focus point inside ``targetCol`` based on drag direction.
 *
 *  - If focus is *after* the anchor in document order (forward drag) and lies
 *    outside the column, the clipped focus is the end of the column's last
 *    text run.
 *  - If focus is *before* the anchor (backward drag), the clipped focus is
 *    the start of the column's first text run.
 *
 * Returns null when the column has no runs (defensive).
 */
export function clampFocusToColumn(
  anchorNode: Node,
  focusNode: Node,
  targetCol: Element,
): { node: Node; offset: number } | null {
  const runs = targetCol.querySelectorAll(".text-run");
  if (runs.length === 0) return null;

  const cmp = anchorNode.compareDocumentPosition(focusNode);
  const focusAfterAnchor = (cmp & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  if (focusAfterAnchor) {
    const lastRun = runs[runs.length - 1];
    const node = lastRun.firstChild ?? lastRun;
    const offset =
      node.nodeType === Node.TEXT_NODE
        ? (node.textContent ?? "").length
        : (node as Element).childNodes.length;
    return { node, offset };
  } else {
    const firstRun = runs[0];
    const node = firstRun.firstChild ?? firstRun;
    return { node, offset: 0 };
  }
}

/**
 * Legacy helper kept for backwards-compat with any callers that build Ranges
 * directly. Production code uses `clampFocusToColumn` via the live selection.
 */
export function clipRangeToColumn(
  range: Range,
  targetCol: Element,
): Range | null {
  const runs = targetCol.querySelectorAll(".text-run");
  if (runs.length === 0) return null;

  const firstRun = runs[0];
  const lastRun = runs[runs.length - 1];
  const firstNode = firstRun.firstChild ?? firstRun;
  const lastNode = lastRun.firstChild ?? lastRun;
  const lastOffset =
    lastNode.nodeType === Node.TEXT_NODE
      ? (lastNode.textContent ?? "").length
      : (lastNode as Element).childNodes.length;

  const sCol = columnOf(range.startContainer);
  const eCol = columnOf(range.endContainer);
  const startInside = sCol === targetCol;
  const endInside = eCol === targetCol;

  const out = document.createRange();
  if (startInside && !endInside) {
    out.setStart(range.startContainer, range.startOffset);
    out.setEnd(lastNode, lastOffset);
  } else if (!startInside && endInside) {
    out.setStart(firstNode, 0);
    out.setEnd(range.endContainer, range.endOffset);
  } else if (!startInside && !endInside) {
    out.setStart(firstNode, 0);
    out.setEnd(lastNode, lastOffset);
  } else {
    return null;
  }
  return out;
}
