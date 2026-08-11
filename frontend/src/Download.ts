/**
 * "Download" nav button — packages the open document's highlights and AI
 * explanations (definitions, sentence explanations, figure walkthroughs)
 * into the PDF itself and downloads it. Since the browser is the source of
 * truth for personal data (see storage/localStore.ts), the client gathers
 * its own IndexedDB rows and hands them to the stateless
 * `POST /documents/{id}/export`, which embeds them as a PDF attachment (see
 * backend/app/routes/export.py).
 *
 * The result is a normal PDF — safe to email or hand to a friend. When they
 * open it in ScAI-Reader (via "Open PDF…"), `main.ts` notices the embedded
 * bundle in the upload response and re-seeds their local stores, so the same
 * highlights and pop-up explanations appear for them too.
 */

import { exportDocument } from "./api.ts";
import {
  getDocument,
  listAnnotations,
  listExplanationsForDoc,
} from "./storage/localStore.ts";
import { subscribePageInfo } from "./pageNav.ts";

function downloadFilename(original: string): string {
  const base = original.replace(/\.pdf$/i, "");
  return `${base} (highlighted).pdf`;
}

export function buildDownloadButton(onError: (message: string) => void): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "download-button";
  button.disabled = true;
  button.setAttribute("aria-label", "Download PDF with highlights");
  button.title = "Download this PDF with your highlights and explanations";

  const icon = document.createElement("span");
  icon.className = "download-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "⬇";
  const label = document.createElement("span");
  label.className = "download-label";
  label.textContent = "Download";
  button.append(icon, label);

  let currentDocId: string | null = null;
  subscribePageInfo((info) => {
    currentDocId = info?.doc_id ?? null;
    button.disabled = currentDocId == null;
  });

  button.addEventListener("click", () => {
    if (!currentDocId || button.disabled) return;
    void runDownload(currentDocId, button, label, onError);
  });

  return button;
}

async function runDownload(
  docId: string,
  button: HTMLButtonElement,
  label: HTMLElement,
  onError: (message: string) => void,
): Promise<void> {
  button.disabled = true;
  const prevLabel = label.textContent ?? "Download";
  label.textContent = "Preparing…";
  try {
    const doc = await getDocument(docId);
    if (!doc) throw new Error("This document is no longer stored locally.");

    const [annotations, explanations] = await Promise.all([
      listAnnotations(docId),
      listExplanationsForDoc(docId),
    ]);

    const blob = await exportDocument(
      docId,
      { annotations, explanations },
      downloadFilename(doc.filename),
    );

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadFilename(doc.filename);
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Give the browser a beat to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    onError((err as Error).message);
  } finally {
    label.textContent = prevLabel;
    button.disabled = false;
  }
}
