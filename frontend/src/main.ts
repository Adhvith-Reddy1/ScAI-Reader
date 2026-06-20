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

// Ctrl/Cmd + wheel = zoom. Steps proportionally so a small scroll = one step.
viewer.addEventListener(
  "wheel",
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY / 300);
    setZoom(getZoom() * factor);
  },
  { passive: false },
);

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
