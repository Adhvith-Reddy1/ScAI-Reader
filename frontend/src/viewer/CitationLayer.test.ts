import { describe, expect, it, vi } from "vitest";
import type { CitationMention } from "../api.ts";
import type { PageGeometry } from "./coords.ts";
import { buildCitationLayer, groupMentionsByBBox } from "./CitationLayer.ts";

const GEOM: PageGeometry = {
  pageWidthPt: 600,
  pageHeightPt: 800,
  displayWidthPx: 600,
  displayHeightPx: 800,
};

function mention(key: string, bbox = { x0: 10, y0: 20, x1: 15, y1: 28 }): CitationMention {
  return { key, page: 1, bbox };
}

describe("groupMentionsByBBox", () => {
  it("groups mentions sharing the same bbox into one marker", () => {
    const bbox = { x0: 10, y0: 20, x1: 30, y1: 28 };
    const groups = groupMentionsByBBox([mention("21", bbox), mention("22", bbox)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].keys).toEqual(["21", "22"]);
  });

  it("keeps distinct bboxes as separate markers", () => {
    const groups = groupMentionsByBBox([
      mention("1", { x0: 10, y0: 20, x1: 15, y1: 28 }),
      mention("2", { x0: 100, y0: 20, x1: 105, y1: 28 }),
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe("buildCitationLayer", () => {
  it("renders one clickable marker per bbox group with the right keys", () => {
    const svg = buildCitationLayer([mention("1")], GEOM, () => {});
    const markers = svg.querySelectorAll(".citation-marker");
    expect(markers).toHaveLength(1);
    expect(markers[0].getAttribute("data-citation-keys")).toBe("1");
    expect(markers[0].querySelector(".citation-marker-text")?.textContent).toBe("1");
  });

  it("skips degenerate zero-size bboxes", () => {
    const svg = buildCitationLayer(
      [mention("1", { x0: 10, y0: 20, x1: 10, y1: 20 })],
      GEOM,
      () => {},
    );
    expect(svg.querySelectorAll(".citation-marker")).toHaveLength(0);
  });

  it("calls onActivate with all keys sharing a bbox when clicked", () => {
    const bbox = { x0: 10, y0: 20, x1: 30, y1: 28 };
    const onActivate = vi.fn();
    const svg = buildCitationLayer(
      [mention("3", bbox), mention("7", bbox)],
      GEOM,
      onActivate,
    );
    const marker = svg.querySelector<SVGGElement>(".citation-marker")!;
    marker.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0][0]).toEqual(["3", "7"]);
    expect(onActivate.mock.calls[0][1]).toBe(marker);
  });

  it("activates on Enter and Space keydown for keyboard accessibility", () => {
    const onActivate = vi.fn();
    const svg = buildCitationLayer([mention("1")], GEOM, onActivate);
    const marker = svg.querySelector<SVGGElement>(".citation-marker")!;

    marker.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    marker.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(onActivate).toHaveBeenCalledTimes(2);

    marker.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(onActivate).toHaveBeenCalledTimes(2);
  });
});
