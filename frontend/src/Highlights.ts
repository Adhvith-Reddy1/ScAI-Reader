/**
 * Sidebar panel: highlighted terms and sentences for the active document.
 *
 * Reads straight from the browser's local annotation store (IndexedDB) —
 * there's no server round trip, same as the highlights themselves. Rows are
 * listed in reading order (page, then creation time) rather than grouped, to
 * keep this a plain mirror of Outline.ts until we decide what a click should
 * do (jump to the highlight? open its AI explanation? both?).
 *
 * Refreshes on two signals: pageNav's doc_id (a different document opened)
 * and annotationEvents (a highlight was created/deleted anywhere in the
 * viewer for the currently-shown document).
 */

import type { HighlightColor } from "./api.ts";
import { subscribeAnnotationsChanged } from "./annotationEvents.ts";
import { subscribePageInfo } from "./pageNav.ts";
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
      list.appendChild(buildRow(ann));
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

function buildRow(ann: LocalAnnotation): HTMLElement {
  const row = document.createElement("div");
  row.className = "highlights-row";
  row.dataset.annotationId = ann.id;

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
  return row;
}
