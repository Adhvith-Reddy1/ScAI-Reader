/**
 * "Recent documents" panel shown on the empty viewer state.
 *
 * The library is now **browser-local**: PDFs (bytes + metadata) live in
 * IndexedDB (see `storage/localStore.ts`), not on the server. Clicking a tile
 * re-supplies the stored bytes to the server for rendering (handled in
 * main.ts); deleting a tile removes the document and all its highlights /
 * explanations / view state via the cascade in `deleteDocument`.
 */

import { listDocuments, type LocalDocument } from "./storage/localStore.ts";

/** Document metadata as stored locally, without the PDF blob. */
export type LibraryItem = Omit<LocalDocument, "blob">;

export async function buildLibrary(
  onOpen: (item: LibraryItem) => void,
  onDelete?: (id: string) => void | Promise<void>,
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

  let docs: LibraryItem[] = [];
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

  // Most-recently-added first (IndexedDB returns rows in key order, not time).
  docs.sort((a, b) => b.added_at.localeCompare(a.added_at));

  for (const doc of docs) {
    list.appendChild(buildTile(doc, onOpen, onDelete, list));
  }
  return root;
}

function buildTile(
  doc: LibraryItem,
  onOpen: (item: LibraryItem) => void,
  onDelete: ((id: string) => void | Promise<void>) | undefined,
  list: HTMLElement,
): HTMLElement {
  const tile = document.createElement("div");
  tile.className = "library-tile";

  // The tile body is the open button; the delete control sits beside it so a
  // click on "remove" doesn't also open the document.
  const open = document.createElement("button");
  open.type = "button";
  open.className = "library-tile-open";
  open.setAttribute("aria-label", `Open ${doc.filename}`);

  const title = document.createElement("div");
  title.className = "library-tile-title";
  title.textContent = doc.title || doc.filename;
  open.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "library-tile-meta";
  const parts: string[] = [];
  parts.push(`${doc.page_count} page${doc.page_count === 1 ? "" : "s"}`);
  if (doc.author) parts.push(doc.author);
  parts.push(formatSize(doc.size_bytes));
  meta.textContent = parts.join("  ·  ");
  open.appendChild(meta);

  const filename = document.createElement("div");
  filename.className = "library-tile-filename";
  filename.textContent = doc.filename;
  open.appendChild(filename);

  open.addEventListener("click", () => onOpen(doc));
  tile.appendChild(open);

  if (onDelete) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "library-tile-delete";
    del.title = "Remove from library";
    del.setAttribute("aria-label", `Remove ${doc.filename} from library`);
    del.textContent = "×";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      del.disabled = true;
      try {
        await onDelete(doc.id);
      } catch {
        del.disabled = false;
        return;
      }
      tile.remove();
      if (list.querySelectorAll(".library-tile").length === 0) {
        list.appendChild(
          buildEmpty("No documents yet. Click Open PDF… above."),
        );
      }
    });
    tile.appendChild(del);
  }

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
