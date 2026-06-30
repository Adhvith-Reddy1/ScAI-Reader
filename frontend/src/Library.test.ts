import { describe, it, expect, vi, beforeEach } from "vitest";

// The library now reads from the browser-local store, not the network.
vi.mock("./storage/localStore.ts", () => ({
  listDocuments: vi.fn(),
}));

import { buildLibrary, formatSize, type LibraryItem } from "./Library.ts";
import { listDocuments } from "./storage/localStore.ts";

const mockList = listDocuments as unknown as ReturnType<typeof vi.fn>;

const ANIMAL: LibraryItem = {
  id: "abc1234567890",
  filename: "Animal_farm.pdf",
  page_count: 44,
  title: " Animal Farm",
  author: "George Orwell",
  size_bytes: 121925,
  added_at: "2026-06-18T10:54:44Z",
};
const LAB: LibraryItem = {
  id: "def4567890123",
  filename: "Virtual Lab.pdf",
  page_count: 22,
  title: "The Virtual Lab",
  author: "Kyle Swanson",
  size_bytes: 18175802,
  added_at: "2026-06-18T11:42:00Z",
};

beforeEach(() => {
  document.body.innerHTML = "";
  mockList.mockReset();
});

describe("formatSize", () => {
  it("bytes", () => expect(formatSize(512)).toBe("512 B"));
  it("kilobytes", () => expect(formatSize(2048)).toBe("2 KB"));
  it("megabytes", () => expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB"));
});

describe("buildLibrary", () => {
  it("renders tiles from the local store, most-recent first", async () => {
    mockList.mockResolvedValue([ANIMAL, LAB]);

    const onOpen = vi.fn();
    const root = await buildLibrary(onOpen);
    document.body.appendChild(root);

    const tiles = root.querySelectorAll(".library-tile");
    expect(tiles.length).toBe(2);
    // LAB was added later, so it sorts first.
    expect(tiles[0].textContent).toContain("Virtual Lab");
    expect(tiles[1].textContent).toContain("Animal Farm");

    (tiles[1].querySelector(".library-tile-open") as HTMLButtonElement).click();
    expect(onOpen).toHaveBeenCalledWith(ANIMAL);
  });

  it("renders empty message when there are no documents", async () => {
    mockList.mockResolvedValue([]);
    const root = await buildLibrary(() => {});
    document.body.appendChild(root);
    expect(root.querySelector(".library-empty")?.textContent).toContain(
      "No documents",
    );
  });

  it("renders error message when listDocuments throws", async () => {
    mockList.mockRejectedValue(new Error("boom"));
    const root = await buildLibrary(() => {});
    document.body.appendChild(root);
    expect(root.querySelector(".library-empty")?.textContent).toContain(
      "Could not load",
    );
  });

  it("delete removes the tile and calls onDelete with the id", async () => {
    mockList.mockResolvedValue([ANIMAL]);
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const root = await buildLibrary(() => {}, onDelete);
    document.body.appendChild(root);

    const del = root.querySelector(".library-tile-delete") as HTMLButtonElement;
    del.click();
    await new Promise((r) => setTimeout(r, 0)); // let the async handler settle

    expect(onDelete).toHaveBeenCalledWith(ANIMAL.id);
    expect(root.querySelectorAll(".library-tile").length).toBe(0);
    expect(root.querySelector(".library-empty")?.textContent).toContain(
      "No documents",
    );
  });

  it("omits the delete control when no onDelete is provided", async () => {
    mockList.mockResolvedValue([ANIMAL]);
    const root = await buildLibrary(() => {});
    document.body.appendChild(root);
    expect(root.querySelector(".library-tile-delete")).toBeNull();
  });
});
