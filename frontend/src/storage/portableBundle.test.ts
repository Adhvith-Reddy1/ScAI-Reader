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
  putViewState,
  type LocalAnnotation,
  type LocalExplanation,
} from "./localStore.ts";

/** Simulate a brand-new browser: fresh IndexedDB and a fresh DB connection. */
function freshBrowser(): void {
  globalThis.indexedDB = new IDBFactory();
  _resetDbPromiseForTest();
}
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  exportBundle,
  importBundle,
  parseBundle,
  serializeBundle,
} from "./portableBundle.ts";

function ann(overrides: Partial<LocalAnnotation> = {}): LocalAnnotation {
  return {
    id: "ann-1",
    docId: "doc-1",
    page: 1,
    kind: "highlight",
    color: "yellow",
    rects: [{ x0: 0, y0: 0, x1: 1, y1: 1 }],
    text: "entropy",
    explain: true,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function expl(overrides: Partial<LocalExplanation> = {}): LocalExplanation {
  return {
    docId: "doc-1",
    annotationId: "ann-1",
    kind: "definition",
    text: "entropy",
    content: "A measure of disorder.",
    status: "complete",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const NOW = "2026-07-04T00:00:00.000Z";

beforeEach(() => {
  freshBrowser();
});

describe("exportBundle", () => {
  it("collects a document's annotations and explanations", async () => {
    await putAnnotation(ann({ id: "a", page: 1 }));
    await putAnnotation(ann({ id: "b", page: 2 }));
    await putExplanation(expl({ annotationId: "a", content: "x" }));
    await putExplanation(expl({ annotationId: "b", content: "y" }));
    // A figure explanation for the same doc (shares the explanations store).
    await putExplanation(
      expl({ annotationId: "fig-1", kind: "explanation", content: "a chart" }),
    );
    // Noise from another document must not leak into the bundle.
    await putAnnotation(ann({ id: "z", docId: "doc-2" }));
    await putExplanation(expl({ docId: "doc-2", annotationId: "z" }));

    const bundle = await exportBundle("doc-1", NOW, "paper.pdf");

    expect(bundle).toMatchObject({
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      docId: "doc-1",
      filename: "paper.pdf",
      exported_at: NOW,
    });
    expect(bundle.annotations.map((a) => a.id).sort()).toEqual(["a", "b"]);
    expect(bundle.explanations.map((e) => e.annotationId).sort()).toEqual([
      "a",
      "b",
      "fig-1",
    ]);
  });

  it("exports an empty bundle for a document with nothing stored", async () => {
    const bundle = await exportBundle("empty", NOW);
    expect(bundle.annotations).toEqual([]);
    expect(bundle.explanations).toEqual([]);
  });
});

describe("parseBundle", () => {
  it("round-trips through serialize/parse", async () => {
    await putAnnotation(ann());
    await putExplanation(expl());
    const bundle = await exportBundle("doc-1", NOW);
    expect(parseBundle(serializeBundle(bundle))).toEqual(bundle);
  });

  it("rejects non-bundles and unknown versions", () => {
    expect(() => parseBundle("not json{")).toThrow(/invalid JSON/);
    expect(() => parseBundle(JSON.stringify({ format: "other" }))).toThrow(
      /not a ScAI annotation bundle/,
    );
    expect(() =>
      parseBundle(
        JSON.stringify({
          format: BUNDLE_FORMAT,
          version: 999,
          docId: "d",
          annotations: [],
          explanations: [],
        }),
      ),
    ).toThrow(/unsupported bundle version/);
    expect(() =>
      parseBundle(
        JSON.stringify({ format: BUNDLE_FORMAT, version: 1, annotations: [] }),
      ),
    ).toThrow(/missing its document id/);
  });
});

describe("importBundle", () => {
  it("writes annotations + explanations into a fresh store", async () => {
    await putAnnotation(ann({ id: "a" }));
    await putExplanation(expl({ annotationId: "a" }));
    const bundle = await exportBundle("doc-1", NOW);

    // Simulate the friend's empty browser.
    freshBrowser();

    const result = await importBundle(bundle);
    expect(result).toEqual({ docId: "doc-1", annotations: 1, explanations: 1 });

    expect((await listAnnotations("doc-1")).map((a) => a.id)).toEqual(["a"]);
    const got = await getExplanation("doc-1", "a");
    expect(got?.content).toBe("A measure of disorder.");
  });

  it("re-keys rows to a target docId (embedded-PDF hash differs)", async () => {
    await putAnnotation(ann({ id: "a" }));
    await putExplanation(expl({ annotationId: "a" }));
    const bundle = await exportBundle("doc-1", NOW);

    freshBrowser();

    await importBundle(bundle, "doc-marked");

    // Original id holds nothing; the target id holds everything, re-keyed.
    expect(await listAnnotations("doc-1")).toEqual([]);
    const reAnns = await listAnnotations("doc-marked");
    expect(reAnns).toHaveLength(1);
    expect(reAnns[0].docId).toBe("doc-marked");
    const got = await getExplanation("doc-marked", "a");
    expect(got?.docId).toBe("doc-marked");
    expect(got?.content).toBe("A measure of disorder.");
  });

  it("is idempotent and merges (re-import overwrites by key)", async () => {
    await putAnnotation(ann({ id: "a" }));
    await putExplanation(expl({ annotationId: "a", content: "v1" }));
    const bundle = await exportBundle("doc-1", NOW);

    await importBundle(bundle);
    await importBundle(bundle);

    expect(await listAnnotations("doc-1")).toHaveLength(1);
    expect((await getExplanation("doc-1", "a"))?.content).toBe("v1");
  });

  it("does not disturb view state or other documents", async () => {
    await putViewState({
      docId: "doc-1",
      lastPage: 4,
      zoom: 1,
      sidebarOpen: true,
    });
    const bundle = await exportBundle("doc-1", NOW);
    // No viewState field on the bundle — it's personal, not citation data.
    expect("viewState" in bundle).toBe(false);
  });
});
