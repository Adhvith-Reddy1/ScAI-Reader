import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildCitationLayer } from "./CitationLayer.ts";
import type { CitationMarker } from "../api.ts";
import type { PageGeometry } from "./coords.ts";

// CitationLayer pulls in CitationCard -> referenceStore -> api. Stub the card
// so a click in jsdom doesn't hit the network; we only assert wiring here.
vi.mock("./CitationCard.ts", () => ({ showCitationCard: vi.fn() }));
import { showCitationCard } from "./CitationCard.ts";

const geom: PageGeometry = {
  pageWidthPt: 612,
  pageHeightPt: 792,
  displayWidthPx: 900,
  displayHeightPx: 1164.7,
};

function markers(): CitationMarker[] {
  return [
    {
      marker_id: "p0_c0",
      page: 1,
      bbox: { x0: 100, y0: 200, x1: 120, y1: 212 },
      numbers: [1],
      raw: "[1]",
    },
    {
      marker_id: "p0_c1",
      page: 1,
      bbox: { x0: 300, y0: 200, x1: 330, y1: 212 },
      numbers: [2, 3],
      raw: "[2, 3]",
    },
  ];
}

describe("buildCitationLayer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates one .citation-marker button per marker", () => {
    const root = buildCitationLayer("doc1", markers(), geom);
    expect(root.querySelectorAll(".citation-marker").length).toBe(2);
  });

  it("scales the hotspot from page-space to viewport-space", () => {
    const root = buildCitationLayer("doc1", markers(), geom);
    const first = root.querySelector(".citation-marker") as HTMLButtonElement;
    expect(parseFloat(first.style.left)).toBeCloseTo(100 * (900 / 612), 1);
    expect(parseFloat(first.style.top)).toBeCloseTo(200 * (1164.7 / 792), 1);
  });

  it("opens the citation card with the marker on click", () => {
    const ms = markers();
    const root = buildCitationLayer("doc1", ms, geom);
    const second = root.querySelectorAll(".citation-marker")[1] as HTMLButtonElement;
    second.click();
    expect(showCitationCard).toHaveBeenCalledOnce();
    const [docId, marker] = (showCitationCard as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(docId).toBe("doc1");
    expect(marker.numbers).toEqual([2, 3]);
  });

  it("renders nothing when there are no markers", () => {
    const root = buildCitationLayer("doc1", [], geom);
    expect(root.querySelectorAll(".citation-marker").length).toBe(0);
  });
});
