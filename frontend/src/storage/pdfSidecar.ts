/**
 * Embed a portable annotation bundle *inside* a PDF so a single file carries
 * both the document and its highlights + AI explanations. A reader can download
 * their annotated PDF, send it to a friend, and the friend's app restores the
 * citations and cached explanations — no LLM calls, no second file.
 *
 * How it's stored: the bundle JSON (base64) is appended after the PDF's bytes,
 * wrapped in sentinel markers. PDF viewers stop at the last `%%EOF` and ignore
 * trailing bytes, so the file still opens normally everywhere; our reader scans
 * the tail for the marker and pulls the bundle back out. This is deliberately
 * dependency-free and symmetric (embed ⇄ extract).
 *
 * Note: appending the bundle changes the file's bytes, hence its SHA-256
 * `docId`. That's expected — `importBundle` re-keys rows to the id the receiver
 * computes for the file it opened. Use `stripBundle` if you need the original
 * (clean) bytes back.
 */

const START_MARKER = "%%SCAI-ANNOTATIONS-BUNDLE-V1:";
const END_MARKER = ":SCAI-ANNOTATIONS-END";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000; // avoid arg-count limits on String.fromCharCode
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Index of the last occurrence of `needle` within `hay` (byte search). */
function lastIndexOfSub(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = hay.length - needle.length; i >= 0; i--) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function indexOfSub(hay: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Append a bundle (JSON string) to a PDF's bytes. If the PDF already carries a
 * bundle, it is replaced (strip-then-append) so re-exporting stays idempotent.
 */
export function embedBundleInPdf(
  pdfBytes: Uint8Array,
  bundleJson: string,
): Uint8Array {
  const base = stripBundle(pdfBytes);
  const payload = bytesToBase64(encoder.encode(bundleJson));
  const trailer = encoder.encode(
    `\n${START_MARKER}${payload}${END_MARKER}\n`,
  );
  const out = new Uint8Array(base.length + trailer.length);
  out.set(base, 0);
  out.set(trailer, base.length);
  return out;
}

/** True if these bytes carry an embedded ScAI annotation bundle. */
export function hasBundle(pdfBytes: Uint8Array): boolean {
  return lastIndexOfSub(pdfBytes, encoder.encode(START_MARKER)) !== -1;
}

/**
 * Extract the embedded bundle JSON, or null if there isn't one. Scans for the
 * last start marker so a re-embedded file returns the most recent bundle.
 */
export function extractBundleFromPdf(pdfBytes: Uint8Array): string | null {
  const startNeedle = encoder.encode(START_MARKER);
  const endNeedle = encoder.encode(END_MARKER);
  const startAt = lastIndexOfSub(pdfBytes, startNeedle);
  if (startAt === -1) return null;
  const payloadStart = startAt + startNeedle.length;
  const endAt = indexOfSub(pdfBytes, endNeedle, payloadStart);
  if (endAt === -1) return null;
  const b64 = decoder.decode(pdfBytes.subarray(payloadStart, endAt));
  try {
    return decoder.decode(base64ToBytes(b64.trim()));
  } catch {
    return null;
  }
}

/**
 * Return the PDF bytes with any embedded bundle (and its leading newline)
 * removed — i.e. the original file. No-op if there's no bundle.
 */
export function stripBundle(pdfBytes: Uint8Array): Uint8Array {
  const startNeedle = encoder.encode(START_MARKER);
  const startAt = lastIndexOfSub(pdfBytes, startNeedle);
  if (startAt === -1) return pdfBytes;
  // Drop the "\n" we prepended before the marker, if present.
  const cut = startAt > 0 && pdfBytes[startAt - 1] === 0x0a ? startAt - 1 : startAt;
  return pdfBytes.subarray(0, cut);
}
