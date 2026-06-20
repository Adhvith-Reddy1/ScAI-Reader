import {
  fetchDocumentDimensions,
  uploadDocument,
  type DocumentDimensions,
  type DocumentMeta,
  type LibraryDocument,
} from "./api.ts";
import {
  clearDocument,
  setDocumentBounds,
  setViewport,
} from "./fit.ts";
import { buildHighlightButton } from "./HighlightButton.ts";
import { subscribeHighlightMode } from "./highlightMode.ts";
import { buildLibrary } from "./Library.ts";
import { buildPageIndicator } from "./PageIndicator.ts";
import { setActivePageList } from "./pageNav.ts";
import { buildPageList, type PageListHandle } from "./viewer/PageList.ts";
import { buildZoomControls } from "./ZoomControls.ts";
import { getZoom, resetZoom, setZoom, zoomIn, zoomOut } from "./zoom.ts";

const fileInput = document.getElementById("file") as HTMLInputElement;
const viewer = document.getElementById("viewer") as HTMLElement;
const docInfo = document.getElementById("doc-info") as HTMLElement;
const buttonSlot = document.getElementById("highlight-button-slot") as HTMLElement;
const zoomSlot = document.getElementById("zoom-controls-slot") as HTMLElement;
const pageIndicatorSlot = document.getElementById(
  "page-indicator-slot",
) as HTMLElement;

buttonSlot.appendChild(buildHighlightButton());
zoomSlot.appendChild(buildZoomControls());
pageIndicatorSlot.appendChild(buildPageIndicator());

subscribeHighlightMode((s) => {
  document.documentElement.dataset.highlightActive = String(s.active);
});

window.addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return;

  // Trap Cmd/Ctrl+S so the user doesn't get the browser's "save page" dialog;
  // highlights save automatically and there's nothing else to persist client-side.
  if (e.key.toLowerCase() === "s") {
    e.preventDefault();
    toast("Highlights save automatically — no manual save needed.");
    return;
  }

  // Edge-style zoom shortcuts: Cmd/Ctrl + +, =, -, _, 0.
  if (e.key === "+" || e.key === "=") {
    e.preventDefault();
    zoomIn();
  } else if (e.key === "-" || e.key === "_") {
    e.preventDefault();
    zoomOut();
  } else if (e.key === "0") {
    e.preventDefault();
    resetZoom();
  }
});

// Trackpad pinch zoom — Chrome/Edge/Firefox on macOS deliver pinch as a wheel
// event with synthetic `ctrlKey: true`. Cmd/Ctrl + scroll wheel is the same
// path. Listening on `window` (instead of `viewer`) keeps the gesture working
// even when the cursor is over the toolbar or empty page background.
//
// `passive: false` is required so preventDefault() can suppress the browser's
// own page-zoom on the pinch.
let pendingPinchZoom: number | null = null;
let pendingPinchAnchor: { clientX: number; clientY: number } | null = null;

// Apply a zoom while keeping the document point currently under (clientX,
// clientY) anchored there. Without this, the viewer scales from its top-left
// origin and content visibly drifts up/left as you pinch in — which feels
// like the page is scrolling away from the cursor.
function zoomAroundClientPoint(
  clientX: number,
  clientY: number,
  newZoom: number,
): void {
  const oldZoom = getZoom();
  const rect = viewer.getBoundingClientRect();

  // Clamp the anchor to the viewer's visible area. The pinch event's
  // clientX/Y is just the cursor position — which may be over the toolbar
  // (e.g., the user just pressed Enter in the page-jump input). Anchoring
  // to a point above the viewer is mathematically valid but visually wrong:
  // at scrollTop ≈ 1.5M (page 1000 of a textbook), a 50px negative offset
  // pulls the view dozens of pixels per tick. Clamping snaps the anchor
  // back into the visible content area.
  const offsetX = clamp(clientX - rect.left, 0, viewer.clientWidth);
  const offsetY = clamp(clientY - rect.top, 0, viewer.clientHeight);
  const contentX = viewer.scrollLeft + offsetX;
  const contentY = viewer.scrollTop + offsetY;

  setZoom(newZoom);
  // setZoom clamps to [MIN_ZOOM, MAX_ZOOM]; use the actual applied factor so
  // a no-op zoom (already at the cap) doesn't move the scroll position.
  const ratio = oldZoom === 0 ? 1 : getZoom() / oldZoom;

  // Read scrollHeight/scrollWidth — this forces a layout flush so the
  // dimensions reflect the just-zoomed page sizes, AND gives us the precise
  // max scroll values to clamp against. The browser's own clamp can be
  // off by a few pixels per tick on long docs (it uses the pre-zoom
  // scrollHeight if we let it write before reading), so we clamp ourselves.
  const maxScrollLeft = Math.max(0, viewer.scrollWidth - viewer.clientWidth);
  const maxScrollTop = Math.max(0, viewer.scrollHeight - viewer.clientHeight);
  viewer.scrollLeft = clamp(contentX * ratio - offsetX, 0, maxScrollLeft);
  viewer.scrollTop = clamp(contentY * ratio - offsetY, 0, maxScrollTop);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const applyPendingPinchZoom = () => {
  if (pendingPinchZoom == null) return;
  if (pendingPinchAnchor) {
    zoomAroundClientPoint(
      pendingPinchAnchor.clientX,
      pendingPinchAnchor.clientY,
      pendingPinchZoom,
    );
  } else {
    setZoom(pendingPinchZoom);
  }
  pendingPinchZoom = null;
  pendingPinchAnchor = null;
};
const scheduleZoomApply = (): void => {
  // rAF is paused on hidden tabs. Fall back to setTimeout so a pinch begun
  // just before the user switches tabs still applies.
  if (document.visibilityState === "visible") {
    requestAnimationFrame(applyPendingPinchZoom);
  } else {
    setTimeout(applyPendingPinchZoom, 16);
  }
};
window.addEventListener(
  "wheel",
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    // Continuous trackpad pinch fires ~60Hz; rAF-throttle the (expensive)
    // setZoom call so we rebuild text/annotation layers at most once per frame.
    const factor = Math.exp(-e.deltaY / 150);
    const target = (pendingPinchZoom ?? getZoom()) * factor;
    if (pendingPinchZoom == null) scheduleZoomApply();
    pendingPinchZoom = target;
    // Capture the latest cursor position; the most recent one before the rAF
    // fires is the right anchor.
    pendingPinchAnchor = { clientX: e.clientX, clientY: e.clientY };
  },
  { passive: false },
);

// Safari's trackpad pinch — non-standard GestureEvents. `event.scale` is a
// cumulative multiplier across the gesture (resets to 1 on gesturestart).
let gestureStartZoom = 1;
window.addEventListener("gesturestart", (e) => {
  (e as Event).preventDefault();
  gestureStartZoom = getZoom();
});
window.addEventListener("gesturechange", (e) => {
  (e as Event).preventDefault();
  const ge = e as unknown as { scale: number; clientX: number; clientY: number };
  if (typeof ge.scale !== "number" || !isFinite(ge.scale) || ge.scale <= 0) return;
  zoomAroundClientPoint(ge.clientX, ge.clientY, gestureStartZoom * ge.scale);
});
window.addEventListener("gestureend", (e) => (e as Event).preventDefault());

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  docInfo.textContent = "Uploading…";
  try {
    const meta = await uploadDocument(file);
    await renderDocument(meta);
  } catch (err) {
    docInfo.textContent = `Error: ${(err as Error).message}`;
  }
});

let pageList: PageListHandle | null = null;

function pushViewportSize(): void {
  setViewport(viewer.clientWidth, viewer.clientHeight);
}
pushViewportSize();
window.addEventListener("resize", pushViewportSize);

async function renderDocument(
  meta: DocumentMeta | LibraryDocument,
): Promise<void> {
  docInfo.textContent = `${meta.filename} — ${meta.page_count} pages${
    meta.title ? ` — "${meta.title.trim()}"` : ""
  }`;
  if (pageList) {
    pageList.dispose();
    pageList = null;
  }
  setActivePageList(null);
  viewer.innerHTML = "";

  let dims: DocumentDimensions;
  try {
    dims = await fetchDocumentDimensions(meta.id);
  } catch (err) {
    docInfo.textContent = `Error loading document: ${(err as Error).message}`;
    return;
  }

  const maxWidthPt = Math.max(...dims.pages.map((p) => p.width_pt));
  const maxHeightPt = Math.max(...dims.pages.map((p) => p.height_pt));
  setDocumentBounds(maxWidthPt, maxHeightPt);
  pushViewportSize();

  pageList = buildPageList(meta, dims.pages, viewer);
  viewer.appendChild(pageList.element);
  setActivePageList(pageList, meta.page_count);
}

async function showLibrary(): Promise<void> {
  if (pageList) {
    pageList.dispose();
    pageList = null;
  }
  setActivePageList(null);
  clearDocument();
  viewer.innerHTML = "";
  const library = await buildLibrary((doc) => {
    void renderDocument(doc);
  });
  viewer.appendChild(library);
}

void showLibrary();

function toast(message: string): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("toast-out"), 1800);
  setTimeout(() => el.remove(), 2200);
}
