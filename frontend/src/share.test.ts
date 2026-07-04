// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetDbPromiseForTest,
  getExplanation,
  listAnnotations,
  putAnnotation,
  putExplanation,
} from "./storage/localStore.ts";
import { hasBundle } from "./storage/pdfSidecar.ts";
import {
  annotatedFilename,
  buildAnnotatedPdf,
  importEmbeddedBundle,
} from "./share.ts";

const NOW = "2026-07-04T00:00:00.000Z";

function freshBrowser(): void {
  globalThis.indexedDB = new IDBFactory();
  _resetDbPromiseForTest();
}

async function seedDoc(docId: string): Promise<void> {
  await putAnnotation({
    id: "ann-1",
    docId,
    page: 1,
    kind: "highlight",
    color: "yellow",
    rects: [{ x0: 0, y0: 0, x1: 1, y1: 1 }],
    text: "entropy",
    explain: true,
    created_at: NOW,
  });
  await putExplanation({
    docId,
    annotationId: "ann-1",
    kind: "definition",
    text: "entropy",
    content: "A measure of disorder.",
    status: "complete",
    updated_at: NOW,
  });
}

const PDF = new TextEncoder().encode("%PDF-1.7\nbody\n%%EOF\n");

beforeEach(() => {
  freshBrowser();
});

describe("annotatedFilename", () => {
  it("inserts .annotated before the .pdf extension", () => {
    expect(annotatedFilename("paper.pdf")).toBe("paper.annotated.pdf");
    expect(annotatedFilename("Paper.PDF")).toBe("Paper.annotated.pdf");
    expect(annotatedFilename("notes")).toBe("notes.annotated.pdf");
  });
});

describe("buildAnnotatedPdf", () => {
  it("embeds the document's annotations + explanations and counts them", async () => {
    await seedDoc("doc-1");
    const blob = new Blob([PDF], { type: "application/pdf" });

    const out = await buildAnnotatedPdf("doc-1", blob, "paper.pdf", NOW);

    expect(out.filename).toBe("paper.annotated.pdf");
    expect(out.annotations).toBe(1);
    expect(out.explanations).toBe(1);
    expect(hasBundle(out.bytes)).toBe(true);
    // The original PDF is a prefix — the file still opens in any viewer.
    expect(out.bytes.subarray(0, PDF.length)).toEqual(PDF);
  });
});

describe("export → import round-trip", () => {
  it("restores annotations under a new docId with no data loss", async () => {
    await seedDoc("doc-orig");
    const blob = new Blob([PDF], { type: "application/pdf" });
    const out = await buildAnnotatedPdf("doc-orig", blob, "paper.pdf", NOW);

    // Fresh browser (the friend); the file they opened hashes to a new id.
    freshBrowser();

    const outcome = await importEmbeddedBundle(out.bytes, "doc-received");
    expect(outcome).toEqual({ annotations: 1, explanations: 1 });

    const anns = await listAnnotations("doc-received");
    expect(anns).toHaveLength(1);
    expect(anns[0].docId).toBe("doc-received");
    expect(anns[0].text).toBe("entropy");
    const expl = await getExplanation("doc-received", "ann-1");
    expect(expl?.content).toBe("A measure of disorder.");
  });

  it("returns null for a PDF with no embedded bundle", async () => {
    expect(await importEmbeddedBundle(PDF, "doc-x")).toBeNull();
  });

  it("throws for a present-but-malformed bundle so callers can warn", async () => {
    // Craft bytes that trip hasBundle but carry non-bundle JSON.
    const { embedBundleInPdf } = await import("./storage/pdfSidecar.ts");
    const bad = embedBundleInPdf(PDF, JSON.stringify({ not: "a bundle" }));
    await expect(importEmbeddedBundle(bad, "doc-x")).rejects.toThrow();
  });
});
