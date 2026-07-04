import { describe, it, expect, vi, beforeEach } from "vitest";
import { showFigureCard, hideFigureCard } from "./FigureCard.ts";
import * as api from "../api.ts";
import * as aiSetup from "../AiSetup.ts";
import type { PageFigure } from "../api.ts";

function fig(id: string): PageFigure {
  return {
    figure_id: id,
    label: "Figure 1",
    page: 1,
    bbox: { x0: 0, y0: 0, x1: 100, y1: 100 },
    caption_bbox: { x0: 0, y0: 100, x1: 100, y1: 110 },
  };
}

const rect = new DOMRect(10, 10, 100, 100);

beforeEach(() => {
  // FigureCard owns a module-level singleton DOM node appended once to
  // document.body — don't wipe body.innerHTML here, or the singleton's cached
  // reference goes stale (detached) while still being reused by ensureCard().
  hideFigureCard();
  vi.restoreAllMocks();
});

describe("FigureCard", () => {
  it("shows an actionable 'Set up AI' button when AI isn't configured", () => {
    vi.spyOn(api, "streamFigureExplanation").mockImplementation(
      (_doc, _id, _page, _label, callbacks) => {
        callbacks.onError("AI isn't set up yet.", api.AI_NOT_CONFIGURED_CODE);
        return () => {};
      },
    );
    const openSpy = vi.spyOn(aiSetup, "openAiSetup").mockImplementation(() => {});

    showFigureCard("doc1", fig("f-not-configured"), rect);

    const button = document.querySelector(
      ".explanation-setup-ai",
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    button.click();
    expect(openSpy).toHaveBeenCalled();
  });

  it("shows the raw message for a non-configuration error", () => {
    vi.spyOn(api, "streamFigureExplanation").mockImplementation(
      (_doc, _id, _page, _label, callbacks) => {
        callbacks.onError("figure explain failed (500)");
        return () => {};
      },
    );

    showFigureCard("doc1", fig("f-other-error"), rect);

    expect(document.querySelector(".explanation-setup-ai")).toBeNull();
    expect(document.querySelector(".figure-card-body")?.textContent).toBe(
      "figure explain failed (500)",
    );
  });

  it("renders streamed content on success", () => {
    vi.spyOn(api, "streamFigureExplanation").mockImplementation(
      (_doc, _id, _page, _label, callbacks) => {
        callbacks.onDelta("The figure shows ");
        callbacks.onDone("The figure shows a bar chart.");
        return () => {};
      },
    );

    showFigureCard("doc1", fig("f-ready"), rect);

    const card = document.querySelector(".figure-card");
    expect(card?.classList.contains("is-ready")).toBe(true);
    expect(document.querySelector(".figure-card-body")?.textContent).toBe(
      "The figure shows a bar chart.",
    );
  });
});
