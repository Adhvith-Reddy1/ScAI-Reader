/**
 * Sidebar panel: highlighted terms and sentences for the active document.
 *
 * Reads straight from the browser's local annotation store (IndexedDB) —
 * there's no server round trip, same as the highlights themselves. Rows are
 * listed in reading order (page, then creation time).
 *
 * Refreshes on two signals: pageNav's doc_id (a different document opened)
 * and annotationEvents (a highlight was created/deleted anywhere in the
 * viewer for the currently-shown document).
 *
 * Each row hovers to reveal a "jump" button that scrolls the viewer to that
 * highlight. Clicking the row body elsewhere (explanation highlights only)
 * toggles an inline preview of its AI definition/explanation beneath the
 * row — the current box text only (Spec 06's `content`, which a follow-up
 * "Update explanation" overwrites), never the full chat thread.
 */

import { renderFormattedText } from "./aiText.ts";
import type { HighlightColor } from "./api.ts";
import { subscribeAnnotationsChanged } from "./annotationEvents.ts";
import {
  getExplanationState,
  hydrateExplanation,
  subscribeExplanation,
  type ExplanationState,
} from "./explanationStore.ts";
import { jumpToAnnotation, subscribePageInfo } from "./pageNav.ts";
import { listAnnotations, type LocalAnnotation } from "./storage/localStore.ts";

const SWATCH_COLOR: Record<HighlightColor, string> = {
  yellow: "#ffeb3b",
  blue: "#2196f3",
  red: "#f44336",
  green: "#4caf50",
  pink: "#e91e63",
};

export function buildHighlightsPanel(): HTMLElement {
  const root = document.createElement("div");
  root.className = "highlights-panel";

  let currentDocId: string | null = null;

  const renderEmpty = (text: string): void => {
    root.innerHTML = "";
    const p = document.createElement("p");
    p.className = "highlights-empty";
    p.textContent = text;
    root.appendChild(p);
  };

  const renderList = (annotations: LocalAnnotation[]): void => {
    root.innerHTML = "";
    if (annotations.length === 0) {
      renderEmpty("No highlights yet.");
      return;
    }
    const sorted = [...annotations].sort(
      (a, b) => a.page - b.page || a.created_at.localeCompare(b.created_at),
    );
    const list = document.createElement("div");
    list.className = "highlights-list";
    for (const ann of sorted) {
      list.appendChild(buildItem(ann));
    }
    root.appendChild(list);
  };

  const load = async (docId: string): Promise<void> => {
    let annotations: LocalAnnotation[];
    try {
      annotations = await listAnnotations(docId);
    } catch {
      annotations = [];
    }
    // Guard against races: only render if this is still the active doc.
    if (docId !== currentDocId) return;
    renderList(annotations);
  };

  renderEmpty("Open a document to see its highlights.");

  subscribePageInfo((info) => {
    const nextId = info?.doc_id ?? null;
    if (nextId === currentDocId) return;
    currentDocId = nextId;
    if (!nextId) {
      renderEmpty("Open a document to see its highlights.");
      return;
    }
    renderEmpty("Loading highlights…");
    void load(nextId);
  });

  subscribeAnnotationsChanged((docId) => {
    if (docId !== currentDocId) return;
    void load(docId);
  });

  return root;
}

function buildItem(ann: LocalAnnotation): HTMLElement {
  const item = document.createElement("div");
  item.className = "highlights-item";

  const row = document.createElement("div");
  row.className = "highlights-row";
  row.dataset.annotationId = ann.id;
  item.appendChild(row);

  const swatch = document.createElement("span");
  swatch.className = "highlights-swatch";
  swatch.style.background = SWATCH_COLOR[ann.color];
  row.appendChild(swatch);

  const body = document.createElement("div");
  body.className = "highlights-body";

  const text = document.createElement("span");
  text.className = "highlights-text";
  text.textContent = ann.text || "(no text selected)";
  body.appendChild(text);

  const meta = document.createElement("span");
  meta.className = "highlights-meta";
  meta.textContent = `${ann.explain ? "Definition" : "Highlight"} · Page ${ann.page}`;
  body.appendChild(meta);

  row.appendChild(body);

  const jumpBtn = document.createElement("button");
  jumpBtn.type = "button";
  jumpBtn.className = "highlights-jump";
  jumpBtn.title = "Jump to highlight";
  jumpBtn.setAttribute("aria-label", "Jump to highlight");
  jumpBtn.textContent = "⏎";
  jumpBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    jumpToAnnotation(ann.page, ann.id);
  });
  row.appendChild(jumpBtn);

  // Only explanation highlights have a definition/explanation to show —
  // plain highlights just jump.
  if (ann.explain) {
    row.classList.add("highlights-row-clickable");

    const detail = document.createElement("div");
    detail.className = "highlights-detail";
    detail.hidden = true;
    item.appendChild(detail);

    let cleanup: (() => void) | null = null;
    row.addEventListener("click", () => {
      if (!detail.hidden) {
        detail.hidden = true;
        cleanup?.();
        cleanup = null;
        return;
      }
      detail.hidden = false;
      cleanup = renderDetail(detail, ann);
    });
  }

  return item;
}

/**
 * Populate `detail` with the highlight's current definition/explanation and
 * keep it live while the panel is open (e.g. a stream still in flight, or the
 * reader hits "Update explanation" elsewhere). Returns a cleanup function to
 * call when the panel is collapsed.
 */
function renderDetail(detail: HTMLElement, ann: LocalAnnotation): () => void {
  let cancelled = false;
  detail.classList.add("is-loading");
  detail.textContent = "Loading…";

  const unsubscribe = subscribeExplanation(ann.id, (state) => {
    if (cancelled) return;
    if (state.status === "idle") return; // handled by the hydrate fallback below
    renderDetailState(detail, state);
  });

  if (getExplanationState(ann.id).status === "idle") {
    void hydrateExplanation(ann.docId, ann.id).then(() => {
      if (cancelled) return;
      if (getExplanationState(ann.id).status === "idle") {
        detail.classList.remove("is-loading");
        detail.textContent = "No explanation has been generated for this highlight yet.";
      }
      // Otherwise the subscription above already rendered the hydrated state.
    });
  }

  return () => {
    cancelled = true;
    unsubscribe();
  };
}

function renderDetailState(detail: HTMLElement, state: ExplanationState): void {
  detail.classList.toggle("is-loading", state.status === "loading");
  detail.classList.toggle("is-error", state.status === "error");
  detail.innerHTML = "";
  if (state.status === "ready" || state.status === "loading") {
    const body = document.createElement("div");
    body.className = "highlights-detail-body";
    renderFormattedText(body, state.content || "…");
    detail.appendChild(body);
  } else if (state.status === "error") {
    const msg = document.createElement("div");
    msg.className = "highlights-detail-error";
    msg.textContent = state.error;
    detail.appendChild(msg);
  }
}
