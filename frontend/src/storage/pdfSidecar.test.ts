// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  embedBundleInPdf,
  extractBundleFromPdf,
  hasBundle,
  stripBundle,
} from "./pdfSidecar.ts";

// A minimal but realistic PDF header/trailer, including binary bytes and an
// %%EOF, so we exercise the "append after EOF" path on non-ASCII content.
function fakePdf(): Uint8Array {
  const head = new TextEncoder().encode("%PDF-1.7\n");
  const binary = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x0a]);
  const tail = new TextEncoder().encode("\nstartxref\n0\n%%EOF\n");
  const out = new Uint8Array(head.length + binary.length + tail.length);
  out.set(head, 0);
  out.set(binary, head.length);
  out.set(tail, head.length + binary.length);
  return out;
}

const BUNDLE_JSON = JSON.stringify({
  format: "scai-annotations",
  version: 1,
  docId: "deadbeef",
  exported_at: "2026-07-04T00:00:00.000Z",
  annotations: [{ id: "a", note: "café ☕ — em—dash" }],
  explanations: [],
});

describe("pdfSidecar embed/extract", () => {
  it("round-trips the bundle through a PDF, preserving unicode", () => {
    const pdf = fakePdf();
    const embedded = embedBundleInPdf(pdf, BUNDLE_JSON);

    expect(hasBundle(pdf)).toBe(false);
    expect(hasBundle(embedded)).toBe(true);
    expect(extractBundleFromPdf(embedded)).toBe(BUNDLE_JSON);
  });

  it("leaves the original PDF bytes untouched at the front", () => {
    const pdf = fakePdf();
    const embedded = embedBundleInPdf(pdf, BUNDLE_JSON);
    // The PDF is a strict prefix of the embedded file → viewers see it intact.
    expect(embedded.subarray(0, pdf.length)).toEqual(pdf);
    expect(embedded.length).toBeGreaterThan(pdf.length);
  });

  it("stripBundle recovers the exact original bytes", () => {
    const pdf = fakePdf();
    const embedded = embedBundleInPdf(pdf, BUNDLE_JSON);
    expect(stripBundle(embedded)).toEqual(pdf);
  });

  it("re-embedding replaces the bundle rather than stacking it", () => {
    const pdf = fakePdf();
    const once = embedBundleInPdf(pdf, BUNDLE_JSON);
    const other = JSON.stringify({
      format: "scai-annotations",
      version: 1,
      docId: "deadbeef",
      exported_at: "x",
      annotations: [],
      explanations: [],
    });
    const twice = embedBundleInPdf(once, other);

    expect(extractBundleFromPdf(twice)).toBe(other);
    expect(stripBundle(twice)).toEqual(pdf);
  });

  it("returns null / false for a PDF with no bundle", () => {
    const pdf = fakePdf();
    expect(hasBundle(pdf)).toBe(false);
    expect(extractBundleFromPdf(pdf)).toBeNull();
    expect(stripBundle(pdf)).toEqual(pdf);
  });
});
