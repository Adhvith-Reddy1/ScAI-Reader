export interface DocumentMeta {
  id: string;
  filename: string;
  page_count: number;
  title: string | null;
  author: string | null;
}

export async function uploadDocument(file: File): Promise<DocumentMeta> {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch("/documents", { method: "POST", body: form });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`upload failed (${r.status}): ${detail}`);
  }
  return r.json() as Promise<DocumentMeta>;
}

export interface LibraryDocument {
  id: string;
  filename: string;
  page_count: number;
  title: string | null;
  author: string | null;
  size_bytes: number;
  uploaded_at: string;
}

export async function listDocuments(): Promise<LibraryDocument[]> {
  const r = await fetch("/documents");
  if (!r.ok) throw new Error(`list documents failed (${r.status})`);
  return r.json() as Promise<LibraryDocument[]>;
}

export function pageImageUrl(docId: string, pageNumber: number, dpi = 150): string {
  return `/documents/${docId}/pages/${pageNumber}.png?dpi=${dpi}`;
}

export interface PageRun {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  font_size: number;
}

export interface PageColumn {
  bbox: { x0: number; y0: number; x1: number; y1: number };
  runs: PageRun[];
}

export interface PageText {
  page_index: number;
  page_width_pt: number;
  page_height_pt: number;
  columns: PageColumn[];
}

export async function fetchPageText(
  docId: string,
  pageNumber: number,
): Promise<PageText> {
  const r = await fetch(`/documents/${docId}/pages/${pageNumber}/text`);
  if (!r.ok) {
    throw new Error(`text fetch failed (${r.status})`);
  }
  return r.json() as Promise<PageText>;
}

export const HIGHLIGHT_COLORS = ["yellow", "blue", "red", "green", "pink"] as const;
export type HighlightColor = typeof HIGHLIGHT_COLORS[number];

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Annotation {
  id: string;
  page: number;
  kind: "highlight";
  color: HighlightColor;
  rects: Rect[];
  text: string | null;
  created_at: string;
}

export async function createHighlight(
  docId: string,
  page: number,
  color: HighlightColor,
  rects: Rect[],
  text?: string,
): Promise<Annotation> {
  const r = await fetch(`/documents/${docId}/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page, color, rects, text }),
  });
  if (!r.ok) throw new Error(`save highlight failed (${r.status})`);
  return r.json() as Promise<Annotation>;
}

export async function listAnnotations(
  docId: string,
  page?: number,
): Promise<Annotation[]> {
  const url = page == null
    ? `/documents/${docId}/annotations`
    : `/documents/${docId}/annotations?page=${page}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`list annotations failed (${r.status})`);
  return r.json() as Promise<Annotation[]>;
}

export async function deleteAnnotation(
  docId: string,
  annotationId: string,
): Promise<void> {
  const r = await fetch(`/documents/${docId}/annotations/${annotationId}`, {
    method: "DELETE",
  });
  if (!r.ok && r.status !== 204) {
    throw new Error(`delete annotation failed (${r.status})`);
  }
}

export type ExplanationKind = "definition" | "explanation";
export type ExplanationStatus = "pending" | "complete" | "error";

export interface Explanation {
  annotation_id: string;
  kind: ExplanationKind;
  text: string;
  content: string | null;
  status: ExplanationStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export async function getExplanation(
  docId: string,
  annotationId: string,
): Promise<Explanation | null> {
  const r = await fetch(
    `/documents/${docId}/annotations/${annotationId}/explanation`,
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`get explanation failed (${r.status})`);
  return r.json() as Promise<Explanation>;
}

export interface ExplainCallbacks {
  onMeta?: (kind: ExplanationKind, cached: boolean) => void;
  onDelta: (chunk: string) => void;
  onDone: (full: string) => void;
  onError: (message: string) => void;
}

/**
 * Streams an explanation from the backend via Server-Sent Events.
 * Returns an abort function so callers can cancel if the user navigates away.
 */
export function streamExplanation(
  docId: string,
  annotationId: string,
  text: string,
  callbacks: ExplainCallbacks,
): () => void {
  const ctrl = new AbortController();

  void (async () => {
    let r: Response;
    try {
      r = await fetch(
        `/documents/${docId}/annotations/${annotationId}/explain`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal: ctrl.signal,
        },
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        callbacks.onError((e as Error).message);
      }
      return;
    }

    if (!r.ok || !r.body) {
      callbacks.onError(`explain failed (${r.status})`);
      return;
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          callbacks.onError((e as Error).message);
        }
        return;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      // SSE frames are separated by double newlines.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            const event = JSON.parse(payload) as
              | { type: "meta"; kind: ExplanationKind; cached: boolean }
              | { type: "delta"; text: string }
              | { type: "done"; text: string }
              | { type: "error"; message: string };
            if (event.type === "meta") {
              callbacks.onMeta?.(event.kind, event.cached);
            } else if (event.type === "delta") {
              callbacks.onDelta(event.text);
            } else if (event.type === "done") {
              callbacks.onDone(event.text);
            } else if (event.type === "error") {
              callbacks.onError(event.message);
            }
          } catch {
            // ignore malformed frame
          }
        }
      }
    }
  })();

  return () => ctrl.abort();
}
