import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CitationEntry } from "./api.ts";

const fetchDocumentCitationsMock = vi.fn();

vi.mock("./api.ts", () => ({
  fetchDocumentCitations: (docId: string) => fetchDocumentCitationsMock(docId),
}));

import {
  _resetForTest,
  citationLink,
  getDocumentCitations,
  leadAuthor,
  paperDescription,
} from "./citations.ts";

function entry(overrides: Partial<CitationEntry> = {}): CitationEntry {
  return {
    key: "1",
    raw_text: "Smith, J. A study of things. J Examples 2020.",
    page: 5,
    authors: null,
    title: null,
    year: null,
    venue: null,
    doi: null,
    ...overrides,
  };
}

describe("getDocumentCitations", () => {
  beforeEach(() => {
    _resetForTest();
    fetchDocumentCitationsMock.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("fetches once and caches for subsequent calls", async () => {
    fetchDocumentCitationsMock.mockResolvedValue([entry()]);
    const a = await getDocumentCitations("doc1");
    const b = await getDocumentCitations("doc1");
    expect(a).toEqual(b);
    expect(fetchDocumentCitationsMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed fetch, so the next call retries", async () => {
    fetchDocumentCitationsMock.mockRejectedValueOnce(new Error("boom"));
    await expect(getDocumentCitations("doc1")).rejects.toThrow("boom");

    fetchDocumentCitationsMock.mockResolvedValueOnce([entry()]);
    const result = await getDocumentCitations("doc1");
    expect(result).toHaveLength(1);
    expect(fetchDocumentCitationsMock).toHaveBeenCalledTimes(2);
  });

  it("caches separately per document", async () => {
    fetchDocumentCitationsMock
      .mockResolvedValueOnce([entry({ key: "a" })])
      .mockResolvedValueOnce([entry({ key: "b" })]);
    const a = await getDocumentCitations("doc1");
    const b = await getDocumentCitations("doc2");
    expect(a[0].key).toBe("a");
    expect(b[0].key).toBe("b");
    expect(fetchDocumentCitationsMock).toHaveBeenCalledTimes(2);
  });
});

describe("leadAuthor", () => {
  it("takes the first comma-separated author from the authors field", () => {
    expect(leadAuthor(entry({ authors: "Wallentin L, Becker RC, Budaj A" }))).toBe(
      "Wallentin L",
    );
  });

  it("falls back to the surname encoded in an author-year key", () => {
    expect(
      leadAuthor(entry({ key: "Smith2020", authors: null, raw_text: "1. No comma here." })),
    ).toBe("Smith");
  });

  it("returns null when nothing is available", () => {
    expect(
      leadAuthor(entry({ key: "1", authors: null, raw_text: "1. No comma at all here." })),
    ).toBeNull();
  });

  // Real citation-list layouts confirmed against two real PDFs (an NEJM
  // review article and an FDA report — see backend/tests for the fixture);
  // the backend only fills `authors` when a title is quoted (rare in
  // practice), so this raw_text-derived path is what actually fires for
  // most real numeric-style citations.
  describe("derived from raw_text (Vancouver/NEJM style: 'Surname AB, Surname2 CD. Title...')", () => {
    it("takes the first author (surname + bare initials, no comma between them)", () => {
      const e = entry({
        authors: null,
        raw_text: "1. Pocock SJ, Stone GW. The primary outcome fails — what next?",
      });
      expect(leadAuthor(e)).toBe("Pocock SJ");
    });

    it("strips a 'Jr'/'Sr' generational suffix off the initials", () => {
      const e = entry({
        authors: null,
        raw_text: "17. Mentzer RM Jr, Bartels C, Bolli R, et al. Sodium-hydrogen exchange.",
      });
      expect(leadAuthor(e)).toBe("Mentzer RM Jr");
    });

    it("handles diacritics in the surname", () => {
      const e = entry({
        authors: null,
        raw_text: "45. Fröbert O, Lagerqvist B, et al. Thrombus aspiration during STEMI.",
      });
      expect(leadAuthor(e)).toBe("Fröbert O");
    });
  });

  describe("derived from raw_text (APA-ish style: 'Surname, Initials, Surname2, Initials2, Title...')", () => {
    it("joins a surname-then-initials pair split across two comma segments", () => {
      const e = entry({
        authors: null,
        raw_text:
          "1. DiMasi, J.A., H.G. Grabowski, and R.W. Hansen, Briefing: Cost of Developing a New Drug.",
      });
      expect(leadAuthor(e)).toBe("DiMasi, J.A.");
    });

    it("treats a hyphenated surname (with stray OCR spacing) as one name", () => {
      const e = entry({
        authors: null,
        raw_text:
          "3. Heresco - Levy, U., et al., Efficacy of high-dose glycine in schizophrenia.",
      });
      expect(leadAuthor(e)).toBe("Heresco - Levy, U.");
    });
  });

  describe("derived from raw_text (group/consortium authorship)", () => {
    it("recognizes a trial-group name ending in a known suffix", () => {
      const e = entry({
        authors: null,
        raw_text:
          "31. The SPRINT Research Group. A randomized trial of intensive blood-pressure control.",
      });
      expect(leadAuthor(e)).toBe("The SPRINT Research Group");
    });

    it("recognizes '(ABBREV) Investigators/Collaborators' with parens and an apostrophe", () => {
      const e = entry({
        authors: null,
        raw_text:
          "19. Cholesterol Treatment Trialists’ (CTT) Collaborators. The effects of lowering LDL cholesterol.",
      });
      expect(leadAuthor(e)).toBe(
        "Cholesterol Treatment Trialists’ (CTT) Collaborators",
      );
    });
  });
});

describe("paperDescription", () => {
  it("prefers the backend's confidently-parsed title", () => {
    expect(paperDescription(entry({ title: "A Study of Things" }))).toBe(
      "A Study of Things",
    );
  });

  it("strips a leading single-author prefix, leaving title + venue, when there's no title", () => {
    const e = entry({
      title: null,
      authors: null,
      raw_text: "1. Fuster V, Unraveling the complexities of statistical presentation.",
    });
    expect(paperDescription(e)).toBe(
      "Unraveling the complexities of statistical presentation.",
    );
  });

  it("accepts a second author leaking in when it shares a segment with the title (no comma between them, Vancouver style) — an imprecise but honest result, never a fabricated title", () => {
    const e = entry({
      title: null,
      authors: null,
      raw_text: "1. Pocock SJ, Stone GW. The primary outcome fails. N Engl J Med 2016.",
    });
    expect(paperDescription(e)).toBe(
      "Stone GW. The primary outcome fails. N Engl J Med 2016.",
    );
  });

  it("strips a trailing 'et al.' that shares a segment with the title", () => {
    const e = entry({
      title: null,
      authors: null,
      raw_text:
        "46. Jolly SS, Cairns JA, et al. Randomized trial of primary PCI with or without routine manual thrombectomy.",
    });
    expect(paperDescription(e)).toBe(
      "Randomized trial of primary PCI with or without routine manual thrombectomy.",
    );
  });

  it("strips the group-author prefix for consortium-authored entries", () => {
    const e = entry({
      title: null,
      authors: null,
      raw_text: "31. The SPRINT Research Group. A randomized trial of intensive control.",
    });
    expect(paperDescription(e)).toBe("A randomized trial of intensive control.");
  });

  it("falls back to the full stripped raw_text when nothing looks author-ish", () => {
    const e = entry({
      title: null,
      authors: null,
      raw_text: "1. Roche. Roche provides update on the first two of six studies.",
    });
    expect(paperDescription(e)).toBe(
      "Roche. Roche provides update on the first two of six studies.",
    );
  });
});

describe("citationLink", () => {
  it("prefers a direct DOI link when a DOI was extracted", () => {
    const link = citationLink(entry({ doi: "10.1056/NEJMra1601511" }));
    expect(link.url).toBe("https://doi.org/10.1056/NEJMra1601511");
    expect(link.label).toContain("View paper");
  });

  it("falls back to a Scholar search built from the title", () => {
    const link = citationLink(entry({ title: "A Study of Things" }));
    expect(link.url).toBe(
      "https://scholar.google.com/scholar?q=A%20Study%20of%20Things",
    );
    expect(link.label).toContain("Search for paper");
  });

  it("falls back to the derived description when there is no title either", () => {
    const link = citationLink(
      entry({ title: null, authors: null, raw_text: "1. Doe A. Another one." }),
    );
    expect(link.url).toContain(encodeURIComponent("Another one."));
  });
});
