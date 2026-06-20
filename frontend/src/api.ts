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
  created_at: string;
}

export async function createHighlight(
  docId: string,
  page: number,
  color: HighlightColor,
  rects: Rect[],
): Promise<Annotation> {
  const r = await fetch(`/documents/${docId}/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page, color, rects }),
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
