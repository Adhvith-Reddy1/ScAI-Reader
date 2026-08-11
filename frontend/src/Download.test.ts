import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalAnnotation, LocalDocument, LocalExplanation } from "./storage/localStore.ts";

const getDocumentMock = vi.fn();
const listAnnotationsMock = vi.fn();
const listExplanationsForDocMock = vi.fn();

vi.mock("./storage/localStore.ts", () => ({
  getDocument: (id: string) => getDocumentMock(id),
  listAnnotations: (id: string) => listAnnotationsMock(id),
  listExplanationsForDoc: (id: string) => listExplanationsForDocMock(id),
}));

const exportDocumentMock = vi.fn();
vi.mock("./api.ts", () => ({
  exportDocument: (docId: string, bundle: unknown, filename?: string) =>
    exportDocumentMock(docId, bundle, filename),
}));

import { buildDownloadButton } from "./Download.ts";
import {
  _resetForTest as resetPageNav,
  setActivePageList,
} from "./pageNav.ts";
import type { PageListHandle } from "./viewer/PageList.ts";

function fakePageList(): PageListHandle {
  return {
    element: document.createElement("div"),
    dispose: vi.fn(),
    scrollToPage: vi.fn(),
    getCurrentPage: () => 1,
    subscribeCurrentPage: () => () => {},
  };
}

const doc: Omit<LocalDocument, "blob"> = {
  id: "doc-1",
  filename: "paper.pdf",
  page_count: 3,
  title: "A Paper",
  author: "An Author",
  size_bytes: 1234,
  added_at: "2026-01-01T00:00:00.000Z",
};

const annotations: LocalAnnotation[] = [
  {
    id: "ann-1",
    docId: "doc-1",
    page: 1,
    kind: "highlight",
    color: "blue",
    rects: [{ x0: 0, y0: 0, x1: 1, y1: 1 }],
    text: "term",
    explain: true,
    created_at: "2026-01-01T00:00:00.000Z",
  },
];

const explanations: LocalExplanation[] = [
  {
    docId: "doc-1",
    annotationId: "ann-1",
    kind: "definition",
    text: "term",
    content: "A definition.",
    status: "complete",
    updated_at: "2026-01-01T00:00:01.000Z",
  },
];

beforeEach(() => {
  document.body.innerHTML = "";
  resetPageNav();
  getDocumentMock.mockReset().mockResolvedValue(doc);
  listAnnotationsMock.mockReset().mockResolvedValue(annotations);
  listExplanationsForDocMock.mockReset().mockResolvedValue(explanations);
  exportDocumentMock.mockReset().mockResolvedValue(new Blob(["%PDF-fake"]));
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:mock-url"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  resetPageNav();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Download button", () => {
  it("starts disabled with no document open", () => {
    const btn = buildDownloadButton(vi.fn()) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("enables once a document is open, disables again once closed", () => {
    const btn = buildDownloadButton(vi.fn()) as HTMLButtonElement;
    setActivePageList(fakePageList(), 3, "doc-1");
    expect(btn.disabled).toBe(false);
    setActivePageList(null);
    expect(btn.disabled).toBe(true);
  });

  it("gathers annotations + explanations and downloads the exported PDF", async () => {
    // jsdom tries to actually navigate on a real anchor click; the component
    // only cares that the anchor was clicked with the right href/download,
    // not that the browser followed it.
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    const btn = buildDownloadButton(vi.fn()) as HTMLButtonElement;
    document.body.appendChild(btn);
    setActivePageList(fakePageList(), 3, "doc-1");

    btn.click();
    // Flush the async click handler.
    await vi.waitFor(() => expect(exportDocumentMock).toHaveBeenCalled());

    expect(listAnnotationsMock).toHaveBeenCalledWith("doc-1");
    expect(listExplanationsForDocMock).toHaveBeenCalledWith("doc-1");
    expect(exportDocumentMock).toHaveBeenCalledWith(
      "doc-1",
      { annotations, explanations },
      "paper (highlighted).pdf",
    );
    expect(URL.createObjectURL).toHaveBeenCalled();

    await vi.waitFor(() => expect(btn.disabled).toBe(false));
    expect(btn.textContent).toContain("Download");
    expect(anchorClick).toHaveBeenCalled();
    anchorClick.mockRestore();
  });

  it("reports an error and re-enables the button on failure", async () => {
    exportDocumentMock.mockRejectedValue(new Error("download failed (404)"));
    const onError = vi.fn();
    const btn = buildDownloadButton(onError) as HTMLButtonElement;
    document.body.appendChild(btn);
    setActivePageList(fakePageList(), 3, "doc-1");

    btn.click();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("download failed (404)"));
    expect(btn.disabled).toBe(false);
  });

  it("does nothing when clicked with no document open", () => {
    const btn = buildDownloadButton(vi.fn()) as HTMLButtonElement;
    btn.click();
    expect(exportDocumentMock).not.toHaveBeenCalled();
  });
});
