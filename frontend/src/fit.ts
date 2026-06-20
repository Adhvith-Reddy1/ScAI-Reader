/**
 * Fit mode + base scale. Decouples "how big should a page be at zoom=1.0"
 * from the user's zoom multiplier in [[zoom]].
 *
 *   displayPx = pagePt × baseScale(viewport, fitMode, doc) × zoom
 *
 * Modes:
 *   - "fit-width" (default): the widest page in the doc fills the viewport
 *     width minus padding. Other pages render at the same scale, so portrait
 *     pages stay proportionally narrower.
 *   - "fit-page": each page fits entirely within the viewport (both
 *     dimensions). Picks the constraint that's tighter across the doc.
 *   - "actual": 1 pt = 1/72 inch, scaled by the standard 96dpi factor so
 *     "100%" looks like a paper print.
 */

const CSS_PX_PER_PT = 96 / 72; // 1.333… — same as Chrome/Adobe "100%"

export type FitMode = "fit-width" | "fit-page" | "actual";

interface DocBounds {
  maxWidthPt: number;
  maxHeightPt: number;
}

interface FitState {
  mode: FitMode;
  viewportWidthPx: number;
  viewportHeightPx: number;
  doc: DocBounds | null;
  /** Horizontal breathing room. The viewer has 24px of padding on each side,
   *  but we also leave a little slack so scrollbars don't trigger needlessly. */
  horizontalPadPx: number;
  verticalPadPx: number;
}

const state: FitState = {
  mode: "fit-width",
  viewportWidthPx: 0,
  viewportHeightPx: 0,
  doc: null,
  horizontalPadPx: 48,
  verticalPadPx: 48,
};

const subscribers = new Set<(scale: number) => void>();

export function getFitMode(): FitMode {
  return state.mode;
}

export function setFitMode(mode: FitMode): void {
  if (mode === state.mode) return;
  state.mode = mode;
  emit();
}

export function setViewport(widthPx: number, heightPx: number): void {
  if (widthPx === state.viewportWidthPx && heightPx === state.viewportHeightPx) {
    return;
  }
  state.viewportWidthPx = widthPx;
  state.viewportHeightPx = heightPx;
  emit();
}

export function setDocumentBounds(maxWidthPt: number, maxHeightPt: number): void {
  state.doc = { maxWidthPt, maxHeightPt };
  emit();
}

export function clearDocument(): void {
  state.doc = null;
  emit();
}

export function getBaseScale(): number {
  return computeBaseScale(state);
}

export function subscribeFit(cb: (scale: number) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Exposed for tests; pure. */
export function computeBaseScale(s: FitState): number {
  if (!s.doc || s.viewportWidthPx <= 0) return CSS_PX_PER_PT;
  if (s.mode === "actual") return CSS_PX_PER_PT;

  const widthBudget = Math.max(1, s.viewportWidthPx - s.horizontalPadPx);
  const widthScale = widthBudget / s.doc.maxWidthPt;

  if (s.mode === "fit-width") return widthScale;

  // fit-page
  const heightBudget = Math.max(1, s.viewportHeightPx - s.verticalPadPx);
  const heightScale = heightBudget / s.doc.maxHeightPt;
  return Math.min(widthScale, heightScale);
}

function emit(): void {
  const scale = getBaseScale();
  for (const cb of subscribers) cb(scale);
}

/** For tests. */
export function _resetForTest(): void {
  state.mode = "fit-width";
  state.viewportWidthPx = 0;
  state.viewportHeightPx = 0;
  state.doc = null;
  subscribers.clear();
}
