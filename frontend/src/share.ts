/**
 * Glue between the browser store and the file the user shares: build a PDF with
 * the document's annotations embedded, and restore annotations from a PDF that
 * has them embedded. Kept out of `main.ts` so it's unit-testable without a DOM.
 */
import {
  exportBundle,
  importBundle,
  parseBundle,
  serializeBundle,
} from "./storage/portableBundle.ts";
import {
  embedBundleInPdf,
  extractBundleFromPdf,
  hasBundle,
} from "./storage/pdfSidecar.ts";

export interface AnnotatedExport {
  bytes: Uint8Array;
  filename: string;
  annotations: number;
  explanations: number;
}

/** `paper.pdf` → `paper.annotated.pdf` (case-insensitive extension). */
export function annotatedFilename(filename: string): string {
  const base = /\.pdf$/i.test(filename) ? filename.slice(0, -4) : filename;
  return `${base}.annotated.pdf`;
}

/**
 * Produce a shareable PDF: the original bytes with this document's highlights +
 * explanations embedded. `now` is passed in so callers own the timestamp.
 */
export async function buildAnnotatedPdf(
  docId: string,
  blob: Blob,
  filename: string,
  now: string,
): Promise<AnnotatedExport> {
  const bundle = await exportBundle(docId, now, filename);
  const pdfBytes = new Uint8Array(await blob.arrayBuffer());
  const bytes = embedBundleInPdf(pdfBytes, serializeBundle(bundle));
  return {
    bytes,
    filename: annotatedFilename(filename),
    annotations: bundle.annotations.length,
    explanations: bundle.explanations.length,
  };
}

export interface ImportOutcome {
  annotations: number;
  explanations: number;
}

/**
 * If `bytes` is a PDF with an embedded annotation bundle, import it into the
 * local store under `targetDocId` (the id the app computed for the file it
 * opened — it differs from the bundle's original id because embedding changed
 * the bytes). Returns null when there's no bundle; throws only if a present
 * bundle is malformed, so the caller can tell "nothing to import" from "broken".
 */
export async function importEmbeddedBundle(
  bytes: Uint8Array,
  targetDocId: string,
): Promise<ImportOutcome | null> {
  if (!hasBundle(bytes)) return null;
  const json = extractBundleFromPdf(bytes);
  if (json == null) return null;
  const bundle = parseBundle(json);
  const res = await importBundle(bundle, targetDocId);
  return { annotations: res.annotations, explanations: res.explanations };
}
