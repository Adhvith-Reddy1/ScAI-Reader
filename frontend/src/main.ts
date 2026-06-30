import {
  fetchDocumentDimensions,
  uploadDocument,
  uploadDocumentBlob,
  type DocumentDimensions,
  type DocumentMeta,
} from "./api.ts";
import {
  deleteDocument,
  estimateUsage,
  getDocument,
  getViewState,
  putDocument,
  putViewState,
} from "./storage/localStore.ts";
import {
  clearDocument,
  setDocumentBounds,
  setViewport,
} from "./fit.ts";
import { buildAiSetupButton, maybeShowAiNudge } from "./AiSetup.ts";
import { buildEraseButton } from "./EraseButton.ts";
import { subscribeEraseMode } from "./eraseMode.ts";
import { buildExplainButton } from "./ExplainButton.ts";
import { subscribeExplainMode } from "./explainMode.ts";
import { buildFindBar } from "./FindBar.ts";
import { buildHighlightButton } from "./HighlightButton.ts";
import { subscribeHighlightMode } from "./highlightMode.ts";
import { buildLibrary, type LibraryItem } from "./Library.ts";
import { buildOutlinePanel } from "./Outline.ts";
import { buildPageIndicator } from "./PageIndicator.ts";
import { setActivePageList, subscribePageInfo, jumpToPage } from "./pageNav.ts";
import {
  initSidebar,
  isSidebarVisible,
  mountSidebarPanel,
  setSidebarVisible,
  subscribeSidebarVisibility,
} from "./sidebar.ts";
import { buildSidebarToggle } from "./SidebarToggle.ts";
import { buildPageList, type PageListHandle } from "./viewer/PageList.ts";
import { buildZoomControls } from "./ZoomControls.ts";
import {
  initViewerZoom,
  resetZoomAtViewerCenter,
  zoomAroundClientPoint,
  zoomInAtViewerCenter,
  zoomOutAtViewerCenter,
} from "./viewerZoom.ts";
import { getZoom, setZoom, subscribeZoom } from "./zoom.ts";

const fileInput = document.getElementById("file") as HTMLInputElement;
const viewer = document.getElementById("viewer") as HTMLElement;
const docInfo = document.getElementById("doc-info") as HTMLElement;
const buttonSlot = document.getElementById("highlight-button-slot") as HTMLElement;
const explainSlot = document.getElementById("explain-button-slot") as HTMLElement;
const eraseSlot = document.getElementById("erase-button-slot") as HTMLElement;
const zoomSlot = document.getElementById("zoom-controls-slot") as HTMLElement;
const pageIndicatorSlot = document.getElementById(
  "page-indicator-slot",
) as HTMLElement;
const sidebar = document.getElementById("sidebar") as HTMLElement;

initViewerZoom(viewer);
initSidebar(sidebar);
mountSidebarPanel("outline", "Outline", buildOutlinePanel());

const sidebarToggleSlot = document.getElementById(
  "sidebar-toggle-slot",
) as HTMLElement;
sidebarToggleSlot.appendChild(buildSidebarToggle());
buttonSlot.appendChild(buildHighlightButton());
explainSlot.appendChild(buildExplainButton());
eraseSlot.appendChild(buildEraseButton());
zoomSlot.appendChild(buildZoomControls());
pageIndicatorSlot.appendChild(buildPageIndicator());

const aiSetupSlot = document.getElementById("ai-setup-slot") as HTMLElement;
aiSetupSlot.appendChild(buildAiSetupButton());

const bannerSlot = document.getElementById("banner-slot") as HTMLElement;
void maybeShowAiNudge(bannerSlot);

const findBar = buildFindBar();
viewer.appendChild(findBar.element);

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && findBar.isOpen()) {
    e.preventDefault();
    findBar.hide();
  }
});

subscribeHighlightMode((s) => {
  document.documentElement.dataset.highlightActive = String(s.active);
});
subscribeExplainMode((s) => {
  document.documentElement.dataset.explainActive = String(s.active);
});
subscribeEraseMode((s) => {
  document.documentElement.dataset.eraseActive = String(s.active);
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

  // Cmd/Ctrl+F: open the find bar (Chrome/Edge style in-page find).
  if (e.key.toLowerCase() === "f") {
    e.preventDefault();
    findBar.show();
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
    await persistUpload(file, meta);
    await renderDocument(meta);
  } catch (err) {
    docInfo.textContent = `Error: ${(err as Error).message}`;
  }
});

/**
 * Save an uploaded PDF (bytes + metadata) to the browser-local library, so it
 * survives reload and re-supplies itself to the server on later opens. Warns
 * (non-blocking) when storage is nearly full so a failed write isn't a mystery.
 */
async function persistUpload(file: File, meta: DocumentMeta): Promise<void> {
  const est = await estimateUsage();
  if (est && est.quotaBytes > 0 && est.usageBytes / est.quotaBytes > 0.9) {
    toast("Storage is almost full — remove old PDFs if saving fails.");
  }
  try {
    await putDocument({
      id: meta.id,
      filename: file.name,
      page_count: meta.page_count,
      title: meta.title,
      author: meta.author,
      size_bytes: file.size,
      added_at: new Date().toISOString(),
      blob: file,
    });
  } catch {
    toast("Couldn't save this PDF to your library (storage may be full).");
  }
}

let pageList: PageListHandle | null = null;

function pushViewportSize(): void {
  setViewport(viewer.clientWidth, viewer.clientHeight);
}
pushViewportSize();
window.addEventListener("resize", pushViewportSize);

async function renderDocument(meta: DocumentMeta): Promise<void> {
  currentDocId = meta.id;
  lastKnownPage = 1;
  docInfo.textContent = `${meta.filename} — ${meta.page_count} pages${
    meta.title ? ` — "${meta.title.trim()}"` : ""
  }`;
  // The bar truncates the title with an ellipsis; show the full text on hover.
  docInfo.title = docInfo.textContent;
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
  setActivePageList(pageList, meta.page_count, meta.id);
}

/**
 * Open a document from the browser-local library: re-supply its stored bytes
 * to the server (so a stateless / cold server can render), then restore the
 * saved zoom / sidebar / page. Upload is idempotent (keyed by SHA-256).
 */
async function openDocument(item: LibraryItem): Promise<void> {
  currentDocId = item.id;
  docInfo.textContent = "Loading…";

  const doc = await getDocument(item.id);
  if (!doc) {
    toast("That document is no longer stored locally.");
    void showLibrary();
    return;
  }

  // Restore zoom + sidebar before building the layout to avoid a reflow flash.
  const vs = await getViewState(item.id);
  if (vs) {
    setZoom(vs.zoom);
    setSidebarVisible(vs.sidebarOpen);
  }

  let meta: DocumentMeta;
  try {
    meta = await uploadDocumentBlob(doc.blob, doc.filename);
  } catch (err) {
    docInfo.textContent = `Error: ${(err as Error).message}`;
    return;
  }

  await renderDocument(meta);
  if (vs && vs.lastPage > 1) jumpToPage(vs.lastPage);
}

async function showLibrary(): Promise<void> {
  if (pageList) {
    pageList.dispose();
    pageList = null;
  }
  setActivePageList(null);
  clearDocument();
  currentDocId = null;
  viewer.innerHTML = "";
  const library = await buildLibrary(
    (item) => void openDocument(item),
    async (id) => {
      await deleteDocument(id);
    },
  );
  viewer.appendChild(library);
}

// --- View-state persistence ------------------------------------------------
// While a document is open, remember its zoom / current page / sidebar state so
// reopening it (even in a new session) lands where the reader left off. Writes
// are debounced — zoom and page changes can fire many times a second.
let currentDocId: string | null = null;
let lastKnownPage = 1;
let viewStateTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleViewStatePersist(): void {
  if (viewStateTimer != null) clearTimeout(viewStateTimer);
  viewStateTimer = setTimeout(() => {
    viewStateTimer = null;
    if (!currentDocId) return;
    void putViewState({
      docId: currentDocId,
      lastPage: lastKnownPage,
      zoom: getZoom(),
      sidebarOpen: isSidebarVisible(),
    });
  }, 400);
}

subscribeZoom(() => scheduleViewStatePersist());
subscribeSidebarVisibility(() => scheduleViewStatePersist());
subscribePageInfo((info) => {
  if (info && info.doc_id === currentDocId) {
    lastKnownPage = info.current;
    scheduleViewStatePersist();
  }
});

void showLibrary();

function toast(message: string): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("toast-out"), 1800);
  setTimeout(() => el.remove(), 2200);
}
