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

export interface PageDimension {
  page: number;
  width_pt: number;
  height_pt: number;
}

export interface DocumentDimensions {
  doc_id: string;
  pages: PageDimension[];
}

export async function fetchDocumentDimensions(
  docId: string,
): Promise<DocumentDimensions> {
  const r = await fetch(`/documents/${docId}/dimensions`);
  if (!r.ok) throw new Error(`dimensions fetch failed (${r.status})`);
  return r.json() as Promise<DocumentDimensions>;
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

export interface SearchResult {
  page: number;
  /** HTML snippet — matched terms wrapped in <mark>…</mark> by the server. */
  snippet: string;
}

export interface SearchResponse {
  doc_id: string;
  query: string;
  results: SearchResult[];
}

export async function fetchSearchResults(
  docId: string,
  query: string,
): Promise<SearchResponse> {
  const url = `/documents/${docId}/search?q=${encodeURIComponent(query)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`search failed (${r.status})`);
  return r.json() as Promise<SearchResponse>;
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
  /**
   * Server-side cached explanation, included only for blue highlights that
   * have a `status: "complete"` row in the explanations table. Frontend
   * seeds explanationStore from this so the first hover renders instantly
   * with no follow-up network call.
   */
  explanation?: { kind: ExplanationKind; content: string };
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

export interface OutlineNode {
  title: string;
  page: number | null;
  children: OutlineNode[];
}

export async function fetchOutline(docId: string): Promise<OutlineNode[]> {
  const r = await fetch(`/documents/${docId}/outline`);
  if (!r.ok) throw new Error(`outline fetch failed (${r.status})`);
  const body = (await r.json()) as { doc_id: string; nodes: OutlineNode[] };
  return body.nodes;
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

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatStreamCallbacks {
  onDelta: (chunk: string) => void;
  onDone: (full: string) => void;
  onError: (message: string) => void;
}

/**
 * Reads an SSE response body and dispatches each `data:` frame. Shared by the
 * chat and refine streams (and tolerant of the same wire format the explain
 * endpoints emit). Returns when the stream ends or aborts.
 */
async function consumeSSE(
  body: ReadableStream<Uint8Array>,
  onEvent: (
    event:
      | { type: "meta"; kind?: ExplanationKind; cached?: boolean }
      | { type: "delta"; text: string }
      | { type: "done"; text: string }
      | { type: "error"; message: string },
  ) => void,
  onAbortError: (e: Error) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (e) {
      if ((e as Error).name !== "AbortError") onAbortError(e as Error);
      return;
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          onEvent(JSON.parse(payload));
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  }
}

function streamChatLike(
  url: string,
  body: unknown,
  callbacks: ChatStreamCallbacks,
): () => void {
  const ctrl = new AbortController();
  void (async () => {
    let r: Response;
    try {
      r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") callbacks.onError((e as Error).message);
      return;
    }
    if (!r.ok || !r.body) {
      callbacks.onError(`request failed (${r.status})`);
      return;
    }
    await consumeSSE(
      r.body,
      (event) => {
        if (event.type === "delta") callbacks.onDelta(event.text);
        else if (event.type === "done") callbacks.onDone(event.text);
        else if (event.type === "error") callbacks.onError(event.message);
      },
      (e) => callbacks.onError(e.message),
    );
  })();
  return () => ctrl.abort();
}

export interface ChatRequestBody {
  text: string;
  kind: ExplanationKind;
  content: string;
  messages: ChatTurn[];
}

/** Streams an assistant reply to a follow-up chat turn on a highlight. */
export function streamChat(
  docId: string,
  annotationId: string,
  body: ChatRequestBody,
  callbacks: ChatStreamCallbacks,
): () => void {
  return streamChatLike(
    `/documents/${docId}/annotations/${annotationId}/chat`,
    body,
    callbacks,
  );
}

/**
 * Streams a rewritten definition/explanation that folds in the useful parts
 * of the conversation. On the server this also persists the new text.
 */
export function streamRefine(
  docId: string,
  annotationId: string,
  body: ChatRequestBody,
  callbacks: ChatStreamCallbacks,
): () => void {
  return streamChatLike(
    `/documents/${docId}/annotations/${annotationId}/refine`,
    body,
    callbacks,
  );
}

export interface CitationMarker {
  marker_id: string;
  page: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  /** Reference numbers this marker resolves to ("[3, 5]" -> [3, 5]). */
  numbers: number[];
  /** The literal bracket text, e.g. "[3, 5]". */
  raw: string;
}

export interface PageCitationsResponse {
  doc_id: string;
  page: number;
  page_width_pt: number;
  page_height_pt: number;
  citations: CitationMarker[];
}

export async function fetchPageCitations(
  docId: string,
  pageNumber: number,
): Promise<PageCitationsResponse> {
  const r = await fetch(`/documents/${docId}/pages/${pageNumber}/citations`);
  if (!r.ok) throw new Error(`citations fetch failed (${r.status})`);
  return r.json() as Promise<PageCitationsResponse>;
}

export interface ReferenceEntry {
  number: number;
  authors: string | null;
  title: string | null;
}

export type ReferencesStatus = "complete" | "pending" | "empty" | "error";

export interface ReferencesResponse {
  doc_id: string;
  status: ReferencesStatus;
  references: ReferenceEntry[];
  /** Present on status "error": the backend's failure detail, for display. */
  error?: string | null;
}

/**
 * The parsed bibliography. The first call triggers a one-shot LLM parse on the
 * backend (status may come back "pending" while it runs); subsequent calls hit
 * the cached result. Marker→reference matching is a plain number lookup.
 */
export async function fetchReferences(docId: string): Promise<ReferencesResponse> {
  const r = await fetch(`/documents/${docId}/references`);
  if (!r.ok) throw new Error(`references fetch failed (${r.status})`);
  return r.json() as Promise<ReferencesResponse>;
}

export interface FigureBBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PageFigure {
  figure_id: string;
  label: string;
  page: number;
  bbox: FigureBBox;
  caption_bbox: FigureBBox;
  explanation?: { content: string };
}

export interface PageFiguresResponse {
  doc_id: string;
  page: number;
  page_width_pt: number;
  page_height_pt: number;
  figures: PageFigure[];
}

export async function fetchPageFigures(
  docId: string,
  pageNumber: number,
): Promise<PageFiguresResponse> {
  const r = await fetch(`/documents/${docId}/pages/${pageNumber}/figures`);
  if (!r.ok) throw new Error(`figures fetch failed (${r.status})`);
  return r.json() as Promise<PageFiguresResponse>;
}

export interface FigureExplainCallbacks {
  onMeta?: (cached: boolean) => void;
  onDelta: (chunk: string) => void;
  onDone: (full: string) => void;
  onError: (message: string) => void;
}

export function streamFigureExplanation(
  docId: string,
  figureId: string,
  page: number,
  label: string,
  callbacks: FigureExplainCallbacks,
): () => void {
  const ctrl = new AbortController();
  void (async () => {
    let r: Response;
    try {
      r = await fetch(`/documents/${docId}/figures/${figureId}/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page, label }),
        signal: ctrl.signal,
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") callbacks.onError((e as Error).message);
      return;
    }
    if (!r.ok || !r.body) {
      callbacks.onError(`figure explain failed (${r.status})`);
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
        if ((e as Error).name !== "AbortError") callbacks.onError((e as Error).message);
        return;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
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
              | { type: "meta"; cached: boolean }
              | { type: "delta"; text: string }
              | { type: "done"; text: string }
              | { type: "error"; message: string };
            if (event.type === "meta") callbacks.onMeta?.(event.cached);
            else if (event.type === "delta") callbacks.onDelta(event.text);
            else if (event.type === "done") callbacks.onDone(event.text);
            else if (event.type === "error") callbacks.onError(event.message);
          } catch { /* ignore malformed */ }
        }
      }
    }
  })();
  return () => ctrl.abort();
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
