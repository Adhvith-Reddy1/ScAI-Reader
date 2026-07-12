import { describe, it, expect, beforeEach } from "vitest";
import {
  showCitationCard,
  refreshCitationCard,
  hideCitationCard,
} from "./CitationCard.ts";
import type { CitationMarker } from "../api.ts";

const anchor = {
  left: 10,
  top: 10,
  bottom: 20,
  right: 20,
  width: 10,
  height: 10,
} as DOMRect;

function marker(overrides: Partial<CitationMarker> = {}): CitationMarker {
  return {
    marker_id: "p0_c0",
    page: 1,
    bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
    numbers: [1],
    raw: "[1]",
    source: "heuristic",
    references: [],
    ...overrides,
  };
}

function card(): HTMLElement {
  return document.querySelector(".citation-card") as HTMLElement;
}

describe("CitationCard", () => {
  beforeEach(() => hideCitationCard());

  it("renders the resolved reference author and title", () => {
    showCitationCard(
      "d",
      marker({
        references: [{ number: 1, authors: "A. Smith", title: "Paper One" }],
      }),
      anchor,
      "complete",
    );
    expect(card().textContent).toContain("Paper One");
    expect(card().textContent).toContain("A. Smith");
    expect(card().style.display).toBe("block");
  });

  it("shows a resolving message while the bibliography is pending", () => {
    showCitationCard("d", marker(), anchor, "pending");
    expect(card().textContent).toContain("Resolving");
    expect(card().classList.contains("is-loading")).toBe(true);
  });

  it("reports an empty bibliography", () => {
    showCitationCard("d", marker(), anchor, "empty");
    expect(card().textContent).toContain("No reference list");
  });

  it("shows the error detail when parsing failed", () => {
    showCitationCard("d", marker(), anchor, "error", "BadRequestError: nope");
    expect(card().textContent).toContain("Couldn't read");
    expect(card().textContent).toContain("BadRequestError: nope");
    expect(card().classList.contains("is-error")).toBe(true);
  });

  it("marks a number as not found when parsed but absent from the list", () => {
    showCitationCard("d", marker({ numbers: [9] }), anchor, "complete");
    expect(card().textContent).toContain("Not found");
  });

  it("updates in place when a re-fetch resolves the reference", () => {
    showCitationCard("d", marker(), anchor, "pending");
    expect(card().textContent).toContain("Resolving");
    refreshCitationCard(
      "d",
      [marker({ references: [{ number: 1, authors: "B", title: "Resolved!" }] })],
      "complete",
    );
    expect(card().textContent).toContain("Resolved!");
  });

  it("closes if precision-filtering dropped the open marker", () => {
    showCitationCard("d", marker({ marker_id: "gone" }), anchor, "pending");
    expect(card().style.display).toBe("block");
    // Re-fetch returns a different marker set that no longer includes "gone".
    refreshCitationCard("d", [marker({ marker_id: "other" })], "complete");
    expect(card().style.display).toBe("none");
  });

  it("ignores refreshes for a different document", () => {
    showCitationCard("docA", marker(), anchor, "pending");
    refreshCitationCard("docB", [], "complete");
    // Still open (unaffected by docB).
    expect(card().style.display).toBe("block");
  });
});
