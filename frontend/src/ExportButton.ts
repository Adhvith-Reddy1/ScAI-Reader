/**
 * Toolbar control: download the open PDF with the reader's highlights and AI
 * explanations embedded inside it (see `storage/pdfSidecar.ts`). Sharing that
 * single file lets a friend open it with the same citations — and the cached
 * explanations mean no LLM calls to regenerate them.
 *
 * The button is disabled until a document is open (nothing to export).
 */

export interface ExportButtonHandle {
  element: HTMLElement;
  setEnabled(enabled: boolean): void;
}

export function buildExportButton(
  onExport: () => void | Promise<void>,
): ExportButtonHandle {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "export-button";
  btn.title =
    "Download this PDF with your highlights & explanations embedded, to share";
  btn.setAttribute("aria-label", "Save PDF with annotations");
  btn.disabled = true;

  const glyph = document.createElement("span");
  glyph.className = "export-button-glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = "⤓";
  btn.appendChild(glyph);

  const label = document.createElement("span");
  label.textContent = "Save with notes";
  btn.appendChild(label);

  btn.addEventListener("click", () => void onExport());

  return {
    element: btn,
    setEnabled(enabled: boolean) {
      btn.disabled = !enabled;
    },
  };
}
