/**
 * "Recent documents" panel shown on the empty viewer state.
 *
 * The backend persists uploaded PDFs and their highlights indexed by the
 * file's SHA-256. When the user reloads the page they shouldn't have to
 * re-pick the file from disk — they should be able to click a tile and the
 * existing PageView pipeline does the rest (annotations load automatically).
 */

import { listDocuments, type LibraryDocument } from "./api.ts";

export async function buildLibrary(
  onOpen: (doc: LibraryDocument) => void,
): Promise<HTMLElement> {
  const root = document.createElement("div");
  root.className = "library";

  const heading = document.createElement("h2");
  heading.className = "library-heading";
  heading.textContent = "Recent documents";
  root.appendChild(heading);

  const list = document.createElement("div");
  list.className = "library-list";
  root.appendChild(list);

  let docs: LibraryDocument[] = [];
  try {
    docs = await listDocuments();
  } catch {
    list.appendChild(buildEmpty("Could not load your library."));
    return root;
  }

  if (docs.length === 0) {
    list.appendChild(buildEmpty("No documents yet. Click Open PDF… above."));
    return root;
  }

  for (const doc of docs) {
    list.appendChild(buildTile(doc, onOpen));
  }
  return root;
}

function buildTile(
  doc: LibraryDocument,
  onOpen: (doc: LibraryDocument) => void,
): HTMLElement {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "library-tile";
  tile.setAttribute("aria-label", `Open ${doc.filename}`);

  const title = document.createElement("div");
  title.className = "library-tile-title";
  title.textContent = doc.title || doc.filename;
  tile.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "library-tile-meta";
  const parts: string[] = [];
  parts.push(`${doc.page_count} page${doc.page_count === 1 ? "" : "s"}`);
  if (doc.author) parts.push(doc.author);
  parts.push(formatSize(doc.size_bytes));
  meta.textContent = parts.join("  ·  ");
  tile.appendChild(meta);

  const filename = document.createElement("div");
  filename.className = "library-tile-filename";
  filename.textContent = doc.filename;
  tile.appendChild(filename);

  tile.addEventListener("click", () => onOpen(doc));
  return tile;
}

function buildEmpty(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "library-empty";
  p.textContent = text;
  return p;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
