import {
  uploadDocument,
  type DocumentMeta,
  type LibraryDocument,
} from "./api.ts";
import { buildHighlightButton } from "./HighlightButton.ts";
import { subscribeHighlightMode } from "./highlightMode.ts";
import { buildLibrary } from "./Library.ts";
import { buildPageView } from "./viewer/PageView.ts";
import { buildZoomControls } from "./ZoomControls.ts";
import { getZoom, resetZoom, setZoom, zoomIn, zoomOut } from "./zoom.ts";

const fileInput = document.getElementById("file") as HTMLInputElement;
const viewer = document.getElementById("viewer") as HTMLElement;
const docInfo = document.getElementById("doc-info") as HTMLElement;
const buttonSlot = document.getElementById("highlight-button-slot") as HTMLElement;
const zoomSlot = document.getElementById("zoom-controls-slot") as HTMLElement;

buttonSlot.appendChild(buildHighlightButton());
zoomSlot.appendChild(buildZoomControls());

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
const applyPendingPinchZoom = () => {
  if (pendingPinchZoom == null) return;
  setZoom(pendingPinchZoom);
  pendingPinchZoom = null;
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
    if (pendingPinchZoom == null) requestAnimationFrame(applyPendingPinchZoom);
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
window.addEventListener("gesturechange", (e) => {
  (e as Event).preventDefault();
  const scale = (e as unknown as { scale: number }).scale;
  if (typeof scale !== "number" || !isFinite(scale) || scale <= 0) return;
  setZoom(gestureStartZoom * scale);
});
window.addEventListener("gestureend", (e) => (e as Event).preventDefault());

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  docInfo.textContent = "Uploading…";
  try {
    const meta = await uploadDocument(file);
    renderDocument(meta);
  } catch (err) {
    docInfo.textContent = `Error: ${(err as Error).message}`;
  }
});

function renderDocument(meta: DocumentMeta | LibraryDocument): void {
  docInfo.textContent = `${meta.filename} — ${meta.page_count} pages${
    meta.title ? ` — "${meta.title.trim()}"` : ""
  }`;
  viewer.innerHTML = "";
  for (let i = 1; i <= meta.page_count; i++) {
    viewer.appendChild(buildPageView(meta, i));
  }
}

async function showLibrary(): Promise<void> {
  viewer.innerHTML = "";
  const library = await buildLibrary((doc) => renderDocument(doc));
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
