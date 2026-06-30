/**
 * Browser-local storage (IndexedDB) — the source of truth for personal data.
 *
 * This module implements "Shared Contract A" from `docs/specs/README.md`. PDFs,
 * highlights, AI explanations, and per-document view state all live here in the
 * user's own browser; the server persists nothing personal. Specs 04/05/06 wire
 * the UI to these functions — they import this contract, they do not redefine it.
 *
 * Framework-free and synchronous-looking via async/await. The only shared state
 * is a lazily-opened DB promise; there are no other singletons.
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Rect, HighlightColor, ExplanationKind } from "../api.ts";

export interface LocalDocument {
  id: string; // sha-256 of the file bytes (same id the server uses)
  filename: string;
  page_count: number;
  title: string | null;
  author: string | null;
  size_bytes: number;
  added_at: string; // ISO
  blob: Blob; // the PDF bytes
}

export interface LocalAnnotation {
  id: string; // client-generated (crypto.randomUUID)
  docId: string;
  page: number;
  kind: "highlight";
  color: HighlightColor;
  rects: Rect[];
  text: string | null;
  explain: boolean;
  created_at: string;
}

export interface LocalExplanation {
  docId: string;
  annotationId: string;
  kind: ExplanationKind;
  text: string; // the highlighted text it was generated for
  content: string;
  status: "complete";
  updated_at: string;
}

export interface ViewState {
  docId: string;
  lastPage: number;
  zoom: number;
  sidebarOpen: boolean;
}

const DB_NAME = "scai-reader";
const DB_VERSION = 1;

interface ScaiDB extends DBSchema {
  documents: {
    key: string;
    value: LocalDocument;
  };
  annotations: {
    key: string;
    value: LocalAnnotation;
    indexes: {
      by_doc: string;
      by_doc_page: [string, number];
    };
  };
  explanations: {
    key: [string, string];
    value: LocalExplanation;
  };
  viewState: {
    key: string;
    value: ViewState;
  };
}

let dbPromise: Promise<IDBPDatabase<ScaiDB>> | null = null;

function getDB(): Promise<IDBPDatabase<ScaiDB>> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new Error(
        "IndexedDB is not available in this environment; local storage requires a browser.",
      ),
    );
  }
  if (!dbPromise) {
    dbPromise = openDB<ScaiDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("documents")) {
          db.createObjectStore("documents", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("annotations")) {
          const annotations = db.createObjectStore("annotations", { keyPath: "id" });
          annotations.createIndex("by_doc", "docId");
          annotations.createIndex("by_doc_page", ["docId", "page"]);
        }
        if (!db.objectStoreNames.contains("explanations")) {
          db.createObjectStore("explanations", { keyPath: ["docId", "annotationId"] });
        }
        if (!db.objectStoreNames.contains("viewState")) {
          db.createObjectStore("viewState", { keyPath: "docId" });
        }
      },
    });
  }
  return dbPromise;
}

// Documents --------------------------------------------------------------

export async function putDocument(doc: LocalDocument): Promise<void> {
  const db = await getDB();
  await db.put("documents", doc);
}

export async function getDocument(id: string): Promise<LocalDocument | null> {
  const db = await getDB();
  return (await db.get("documents", id)) ?? null;
}

/** List document metadata only — blobs are stripped to keep this cheap. */
export async function listDocuments(): Promise<Omit<LocalDocument, "blob">[]> {
  const db = await getDB();
  const docs = await db.getAll("documents");
  return docs.map(({ blob: _blob, ...meta }) => meta);
}

/**
 * Delete a document and cascade: its annotations, explanations, and viewState
 * all go in a single transaction so storage never holds orphans.
 */
export async function deleteDocument(id: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(
    ["documents", "annotations", "explanations", "viewState"],
    "readwrite",
  );

  const annotations = tx.objectStore("annotations");
  const annKeys = await annotations.index("by_doc").getAllKeys(id);
  await Promise.all(annKeys.map((key) => annotations.delete(key)));

  const explanations = tx.objectStore("explanations");
  const explKeys = await explanations.getAllKeys(
    IDBKeyRange.bound([id], [id, []]),
  );
  await Promise.all(explKeys.map((key) => explanations.delete(key)));

  await tx.objectStore("viewState").delete(id);
  await tx.objectStore("documents").delete(id);

  await tx.done;
}

// Annotations ------------------------------------------------------------

export async function putAnnotation(a: LocalAnnotation): Promise<void> {
  const db = await getDB();
  await db.put("annotations", a);
}

export async function listAnnotations(
  docId: string,
  page?: number,
): Promise<LocalAnnotation[]> {
  const db = await getDB();
  if (page == null) {
    return db.getAllFromIndex("annotations", "by_doc", docId);
  }
  return db.getAllFromIndex("annotations", "by_doc_page", [docId, page]);
}

export async function deleteAnnotation(
  docId: string,
  id: string,
): Promise<void> {
  const db = await getDB();
  // The annotation keyPath is `id`; `docId` guards against cross-doc deletes.
  const existing = await db.get("annotations", id);
  if (existing && existing.docId === docId) {
    await db.delete("annotations", id);
  }
}

// Explanations (keyed by [docId, annotationId]) --------------------------

export async function putExplanation(e: LocalExplanation): Promise<void> {
  const db = await getDB();
  await db.put("explanations", e);
}

export async function getExplanation(
  docId: string,
  annotationId: string,
): Promise<LocalExplanation | null> {
  const db = await getDB();
  return (await db.get("explanations", [docId, annotationId])) ?? null;
}

// View state -------------------------------------------------------------

export async function getViewState(docId: string): Promise<ViewState | null> {
  const db = await getDB();
  return (await db.get("viewState", docId)) ?? null;
}

export async function putViewState(vs: ViewState): Promise<void> {
  const db = await getDB();
  await db.put("viewState", vs);
}

// Storage health ---------------------------------------------------------

/**
 * Wrap `navigator.storage.estimate()`. Returns `null` when the API is
 * unavailable so callers (Spec 04's quota warning) can degrade gracefully.
 */
export async function estimateUsage(): Promise<
  { usageBytes: number; quotaBytes: number } | null
> {
  if (
    typeof navigator === "undefined" ||
    !navigator.storage ||
    typeof navigator.storage.estimate !== "function"
  ) {
    return null;
  }
  const { usage, quota } = await navigator.storage.estimate();
  if (usage == null || quota == null) return null;
  return { usageBytes: usage, quotaBytes: quota };
}

/** Test-only: drop the cached DB promise so a fresh `openDB` runs next call. */
export function _resetDbPromiseForTest(): void {
  dbPromise = null;
}
