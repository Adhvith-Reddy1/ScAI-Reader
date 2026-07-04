/**
 * Portable annotation bundles — export a document's highlights + AI
 * explanations to a self-describing JSON blob, and import one back into the
 * browser store. This is what lets a reader share their annotated PDF with a
 * friend so the citations and (expensive-to-regenerate) explanations travel
 * with it, instead of being stranded in one browser's IndexedDB.
 *
 * A document's identity is the SHA-256 of its bytes (`docId`), so a bundle
 * re-associates with the *same* PDF automatically — the only missing piece was
 * a way for the annotation rows to travel, which this module provides.
 *
 * The bundle is stamped with the original `docId` for provenance/verification,
 * but `importBundle` re-keys rows to whatever `docId` the receiving app has for
 * the file it actually opened (they differ if the sidecar was embedded into the
 * PDF, since that changes the bytes — see `pdfSidecar.ts`).
 */
import {
  listAnnotations,
  listExplanations,
  putAnnotation,
  putExplanation,
  type LocalAnnotation,
  type LocalExplanation,
} from "./localStore.ts";

export const BUNDLE_FORMAT = "scai-annotations";
export const BUNDLE_VERSION = 1;

export interface AnnotationBundle {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  /** SHA-256 of the original PDF bytes this bundle was exported from. */
  docId: string;
  filename?: string;
  exported_at: string; // ISO
  annotations: LocalAnnotation[];
  explanations: LocalExplanation[];
}

export interface ImportResult {
  docId: string;
  annotations: number;
  explanations: number;
}

/**
 * Read a document's annotations + explanations out of the local store into a
 * portable bundle. Pass `now` (ISO string) so callers control the timestamp —
 * keeps this deterministic and side-effect free apart from the reads.
 */
export async function exportBundle(
  docId: string,
  now: string,
  filename?: string,
): Promise<AnnotationBundle> {
  const [annotations, explanations] = await Promise.all([
    listAnnotations(docId),
    listExplanations(docId),
  ]);
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    docId,
    filename,
    exported_at: now,
    annotations,
    explanations,
  };
}

/** Serialize a bundle to a JSON string suitable for a `.scai.json` download. */
export function serializeBundle(bundle: AnnotationBundle): string {
  return JSON.stringify(bundle);
}

/**
 * Parse and validate a bundle from JSON (or an already-parsed object). Throws a
 * clear error on anything that isn't a bundle of a version we understand, so
 * callers can surface "this file isn't a ScAI annotation bundle" to the user.
 */
export function parseBundle(input: string | unknown): AnnotationBundle {
  let obj: unknown;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch {
      throw new Error("not a valid ScAI annotation bundle (invalid JSON)");
    }
  } else {
    obj = input;
  }

  if (typeof obj !== "object" || obj === null) {
    throw new Error("not a valid ScAI annotation bundle");
  }
  const b = obj as Partial<AnnotationBundle>;
  if (b.format !== BUNDLE_FORMAT) {
    throw new Error("not a ScAI annotation bundle");
  }
  if (b.version !== BUNDLE_VERSION) {
    throw new Error(
      `unsupported bundle version ${String(b.version)} (expected ${BUNDLE_VERSION})`,
    );
  }
  if (typeof b.docId !== "string" || !b.docId) {
    throw new Error("bundle is missing its document id");
  }
  if (!Array.isArray(b.annotations) || !Array.isArray(b.explanations)) {
    throw new Error("bundle is missing annotations/explanations");
  }
  return b as AnnotationBundle;
}

/**
 * Write a bundle's annotations + explanations into the local store. Rows are
 * re-keyed to `targetDocId` (default: the bundle's own `docId`) so a bundle
 * embedded in a re-saved PDF still lands under the id the receiver computed for
 * the file they opened. `putAnnotation`/`putExplanation` overwrite by key, so
 * importing is idempotent and merges cleanly with anything already present.
 */
export async function importBundle(
  bundle: AnnotationBundle,
  targetDocId: string = bundle.docId,
): Promise<ImportResult> {
  await Promise.all(
    bundle.annotations.map((a) =>
      putAnnotation({ ...a, docId: targetDocId }),
    ),
  );
  await Promise.all(
    bundle.explanations.map((e) =>
      putExplanation({ ...e, docId: targetDocId }),
    ),
  );
  return {
    docId: targetDocId,
    annotations: bundle.annotations.length,
    explanations: bundle.explanations.length,
  };
}
