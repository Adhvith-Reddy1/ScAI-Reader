import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CitationEntry } from "../api.ts";

const getDocumentCitationsMock = vi.fn();

vi.mock("../citations.ts", () => ({
  getDocumentCitations: (docId: string) => getDocumentCitationsMock(docId),
  leadAuthor: (entry: CitationEntry) => entry.authors ?? null,
  citationLink: (entry: CitationEntry) => ({
    label: entry.doi ? "View paper ↗" : "Search for paper ↗",
    url: entry.doi ? `https://doi.org/${entry.doi}` : `https://example.com/${entry.key}`,
  }),
}));

import { _resetForTest, hideCitationCard, showCitationCard } from "./CitationCard.ts";

const RECT = { left: 100, top: 100, right: 300, bottom: 200 } as DOMRect;

function entry(overrides: Partial<CitationEntry> = {}): CitationEntry {
  return {
    key: "1",
    raw_text: "Smith, J. A study of things. J Examples 2020.",
    page: 5,
    authors: "Smith, J.",
    title: "A study of things",
    year: "2020",
    venue: null,
    doi: null,
    ...overrides,
  };
}

describe("CitationCard", () => {
  beforeEach(() => {
    _resetForTest();
    getDocumentCitationsMock.mockReset();
    document.body.innerHTML = "";
  });
  afterEach(() => {
    _resetForTest();
    vi.restoreAllMocks();
  });

  it("shows lead author, paper title, and a link for the clicked key", async () => {
    getDocumentCitationsMock.mockResolvedValue([entry()]);
    await showCitationCard("doc", ["1"], RECT);

    const card = document.querySelector<HTMLElement>(".citation-card")!;
    expect(card.style.display).toBe("block");
    expect(card.querySelector(".citation-card-author")!.textContent).toBe("Smith, J.");
    expect(card.querySelector(".citation-card-paper-title")!.textContent).toBe(
      "A study of things",
    );
    const link = card.querySelector<HTMLAnchorElement>(".citation-card-link")!;
    expect(link.textContent).toContain("Search for paper");
    expect(link.href).toBe("https://example.com/1");
    expect(link.target).toBe("_blank");
  });

  it("falls back to raw_text when the title wasn't extracted", async () => {
    getDocumentCitationsMock.mockResolvedValue([entry({ title: null })]);
    await showCitationCard("doc", ["1"], RECT);
    const card = document.querySelector<HTMLElement>(".citation-card")!;
    expect(card.querySelector(".citation-card-paper-title")!.textContent).toBe(
      "Smith, J. A study of things. J Examples 2020.",
    );
  });

  it("renders one block per key for a compound marker", async () => {
    getDocumentCitationsMock.mockResolvedValue([
      entry({ key: "3", authors: "Author Three" }),
      entry({ key: "7", authors: "Author Seven" }),
    ]);
    await showCitationCard("doc", ["3", "7"], RECT);
    const card = document.querySelector<HTMLElement>(".citation-card")!;
    const authors = [...card.querySelectorAll(".citation-card-author")].map(
      (el) => el.textContent,
    );
    expect(authors).toEqual(["Author Three", "Author Seven"]);
  });

  it("shows a 'not found' block for a key with no matching entry", async () => {
    getDocumentCitationsMock.mockResolvedValue([]);
    await showCitationCard("doc", ["99"], RECT);
    const card = document.querySelector<HTMLElement>(".citation-card")!;
    expect(card.querySelector(".citation-card-entry-missing")!.textContent).toContain(
      "Reference 99 not found.",
    );
  });

  it("shows an error state when the fetch fails", async () => {
    getDocumentCitationsMock.mockRejectedValue(new Error("boom"));
    await showCitationCard("doc", ["1"], RECT);
    const card = document.querySelector<HTMLElement>(".citation-card")!;
    expect(card.classList.contains("is-error")).toBe(true);
    expect(card.querySelector(".citation-card-error")!.textContent).toContain(
      "Couldn't load",
    );
  });

  it("clicking outside the card closes it", async () => {
    getDocumentCitationsMock.mockResolvedValue([entry()]);
    await showCitationCard("doc", ["1"], RECT);
    const card = document.querySelector<HTMLElement>(".citation-card")!;

    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(card.style.display).toBe("none");
  });

  it("clicking inside the card does not close it", async () => {
    getDocumentCitationsMock.mockResolvedValue([entry()]);
    await showCitationCard("doc", ["1"], RECT);
    const card = document.querySelector<HTMLElement>(".citation-card")!;

    card
      .querySelector(".citation-card-body")!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(card.style.display).toBe("block");
  });

  it("Escape closes the card", async () => {
    getDocumentCitationsMock.mockResolvedValue([entry()]);
    await showCitationCard("doc", ["1"], RECT);
    const card = document.querySelector<HTMLElement>(".citation-card")!;

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(card.style.display).toBe("none");
  });

  it("the close button closes the card", async () => {
    getDocumentCitationsMock.mockResolvedValue([entry()]);
    await showCitationCard("doc", ["1"], RECT);
    const card = document.querySelector<HTMLElement>(".citation-card")!;

    card.querySelector<HTMLButtonElement>(".citation-card-close")!.click();
    expect(card.style.display).toBe("none");
  });

  it("hideCitationCard closes it explicitly", async () => {
    getDocumentCitationsMock.mockResolvedValue([entry()]);
    await showCitationCard("doc", ["1"], RECT);
    const card = document.querySelector<HTMLElement>(".citation-card")!;

    hideCitationCard();
    expect(card.style.display).toBe("none");
  });

  it("a superseded call (fast second click) does not clobber the latest one", async () => {
    let resolveFirst: (v: CitationEntry[]) => void = () => {};
    getDocumentCitationsMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );
    const first = showCitationCard("doc", ["1"], RECT);

    getDocumentCitationsMock.mockResolvedValueOnce([entry({ key: "2", authors: "Second" })]);
    await showCitationCard("doc", ["2"], RECT);

    resolveFirst([entry({ key: "1", authors: "First" })]);
    await first;

    const card = document.querySelector<HTMLElement>(".citation-card")!;
    expect(card.querySelector(".citation-card-author")!.textContent).toBe("Second");
  });
});
