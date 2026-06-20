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
import {
  buildSearchPanel,
  focusSearchInput,
  setActiveSearchDoc,
} from "./SearchPanel.ts";
import { initSidebar, mountSidebarPanel } from "./sidebar.ts";
import { buildPageList, type PageListHandle } from "./viewer/PageList.ts";
import { buildZoomControls } from "./ZoomControls.ts";
import {
  initViewerZoom,
  resetZoomAtViewerCenter,
  zoomAroundClientPoint,
  zoomInAtViewerCenter,
  zoomOutAtViewerCenter,
} from "./viewerZoom.ts";
import { getZoom, setZoom } from "./zoom.ts";

const fileInput = document.getElementById("file") as HTMLInputElement;
const viewer = document.getElementById("viewer") as HTMLElement;
const docInfo = document.getElementById("doc-info") as HTMLElement;
const buttonSlot = document.getElementById("highlight-button-slot") as HTMLElement;
const zoomSlot = document.getElementById("zoom-controls-slot") as HTMLElement;
const pageIndicatorSlot = document.getElementById(
  "page-indicator-slot",
) as HTMLElement;
const sidebar = document.getElementById("sidebar") as HTMLElement;

initViewerZoom(viewer);
initSidebar(sidebar);
const searchPanel = mountSidebarPanel("search", "Search", buildSearchPanel());

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

  // Cmd/Ctrl+F: open the search panel and focus its input.
  if (e.key.toLowerCase() === "f") {
    e.preventDefault();
    searchPanel.show();
    focusSearchInput();
    return;
  }

  // Edge-style zoom shortcuts: Cmd/Ctrl + +, =, -, _, 0. All anchored at
  // the viewer center so the visible content stays put across zoom steps —
  // without this, on a 5M-px doc a single +/− shifts the view by 100+ pages.
  if (e.key === "+" || e.key === "=") {
    e.preventDefault();
    zoomInAtViewerCenter();
  } else if (e.key === "-" || e.key === "_") {
    e.preventDefault();
    zoomOutAtViewerCenter();
  } else if (e.key === "0") {
    e.preventDefault();
    resetZoomAtViewerCenter();
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
// Anchor for the current gesture. Captured on the FIRST wheel event of a
// gesture and reused for every tick until the gesture ends (no wheel for
// ~200ms). Using a per-tick anchor lets cursor drift during the pinch (your
// fingers spread, the OS reports a slightly-moved "center") propagate into
// scroll, which looks exactly like the page scrolling during zoom.
let currentGestureAnchor: { clientX: number; clientY: number } | null = null;
let gestureEndTimer: ReturnType<typeof setTimeout> | null = null;
const GESTURE_END_MS = 200;

const applyPendingPinchZoom = () => {
  if (pendingPinchZoom == null) return;
  if (currentGestureAnchor) {
    zoomAroundClientPoint(
      currentGestureAnchor.clientX,
      currentGestureAnchor.clientY,
      pendingPinchZoom,
    );
  } else {
    setZoom(pendingPinchZoom);
  }
  pendingPinchZoom = null;
  // Note: do NOT clear currentGestureAnchor here — it persists for the
  // duration of the gesture. The end-timer below clears it.
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
    // First wheel of a gesture: lock the anchor here. Subsequent wheels in
    // the same gesture reuse it, so finger drift on the trackpad doesn't
    // pull the scroll position with it.
    if (currentGestureAnchor == null) {
      currentGestureAnchor = { clientX: e.clientX, clientY: e.clientY };
    }
    if (gestureEndTimer != null) clearTimeout(gestureEndTimer);
    gestureEndTimer = setTimeout(() => {
      currentGestureAnchor = null;
      gestureEndTimer = null;
    }, GESTURE_END_MS);

    // Continuous trackpad pinch fires ~60Hz; rAF-throttle the (expensive)
    // setZoom call so we rebuild text/annotation layers at most once per frame.
    const factor = Math.exp(-e.deltaY / 150);
    const target = (pendingPinchZoom ?? getZoom()) * factor;
    if (pendingPinchZoom == null) scheduleZoomApply();
    pendingPinchZoom = target;
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
let safariGestureAnchor: { clientX: number; clientY: number } | null = null;
window.addEventListener("gesturechange", (e) => {
  (e as Event).preventDefault();
  const ge = e as unknown as { scale: number; clientX: number; clientY: number };
  if (typeof ge.scale !== "number" || !isFinite(ge.scale) || ge.scale <= 0) return;
  if (safariGestureAnchor == null) {
    safariGestureAnchor = { clientX: ge.clientX, clientY: ge.clientY };
  }
  zoomAroundClientPoint(
    safariGestureAnchor.clientX,
    safariGestureAnchor.clientY,
    gestureStartZoom * ge.scale,
  );
});
window.addEventListener("gestureend", (e) => {
  (e as Event).preventDefault();
  safariGestureAnchor = null;
});

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
  setActiveSearchDoc(meta.id);
}

async function showLibrary(): Promise<void> {
  if (pageList) {
    pageList.dispose();
    pageList = null;
  }
  setActivePageList(null);
  setActiveSearchDoc(null);
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
