import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildLibrary, formatSize } from "./Library.ts";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("formatSize", () => {
  it("bytes", () => {
    expect(formatSize(512)).toBe("512 B");
  });
  it("kilobytes", () => {
    expect(formatSize(2048)).toBe("2 KB");
  });
  it("megabytes", () => {
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("buildLibrary", () => {
  it("renders tiles for documents returned by /documents", async () => {
    const docs = [
      {
        id: "abc1234567890",
        filename: "Animal_farm.pdf",
        page_count: 44,
        title: " Animal Farm",
        author: "George Orwell",
        size_bytes: 121925,
        uploaded_at: "2026-06-18T10:54:44Z",
      },
      {
        id: "def4567890123",
        filename: "Virtual Lab.pdf",
        page_count: 22,
        title: "The Virtual Lab",
        author: "Kyle Swanson",
        size_bytes: 18175802,
        uploaded_at: "2026-06-18T11:42:00Z",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string) => ({
        ok: true,
        json: async () => docs,
      })) as unknown as typeof fetch,
    );

    const onOpen = vi.fn();
    const root = await buildLibrary(onOpen);
    document.body.appendChild(root);

    const tiles = root.querySelectorAll(".library-tile");
    expect(tiles.length).toBe(2);
    expect(tiles[0].textContent).toContain("Animal Farm");
    expect(tiles[1].textContent).toContain("Virtual Lab");

    (tiles[0] as HTMLButtonElement).click();
    expect(onOpen).toHaveBeenCalledWith(docs[0]);
    vi.unstubAllGlobals();
  });

  it("renders empty message when no documents exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => [] })) as unknown as typeof fetch,
    );
    const root = await buildLibrary(() => {});
    document.body.appendChild(root);
    expect(root.querySelector(".library-empty")?.textContent).toContain("No documents");
    vi.unstubAllGlobals();
  });

  it("renders error message when listDocuments throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch,
    );
    const root = await buildLibrary(() => {});
    document.body.appendChild(root);
    expect(root.querySelector(".library-empty")?.textContent).toContain("Could not load");
    vi.unstubAllGlobals();
  });
});
