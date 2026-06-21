/**
 * Per-document bibliography cache.
 *
 * The backend parses a document's reference list once (LLM-backed) and caches
 * it. We mirror that here: the first time any page with citations renders we
 * kick off `loadReferences`, which fetches and — if the backend is still
 * parsing (`status: "pending"`) — polls until it settles. Subscribers (the
 * citation card) re-render as the state changes, so clicking a marker before
 * parsing finishes shows "Resolving…" and then fills in.
 *
 * Lookups are by citation number, matching the in-text marker to its entry
 * without relying on PDF hyperlinks.
 */

import {
  fetchReferences,
  type ReferenceEntry,
  type ReferencesStatus,
} from "./api.ts";

export type ReferencesState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; byNumber: Map<number, ReferenceEntry> }
  | { status: "empty" }
  | { status: "error" };

type Subscriber = (state: ReferencesState) => void;

interface Entry {
  state: ReferencesState;
  subscribers: Set<Subscriber>;
  started: boolean;
}

const POLL_INTERVAL_MS = 1500;
const MAX_POLLS = 40; // ~60s ceiling before we give up on a pending parse.

const entries = new Map<string, Entry>();

function ensureEntry(docId: string): Entry {
  let entry = entries.get(docId);
  if (!entry) {
    entry = { state: { status: "idle" }, subscribers: new Set(), started: false };
    entries.set(docId, entry);
  }
  return entry;
}

function setState(entry: Entry, next: ReferencesState): void {
  entry.state = next;
  for (const cb of entry.subscribers) cb(next);
}

export function subscribeReferences(docId: string, cb: Subscriber): () => void {
  const entry = ensureEntry(docId);
  entry.subscribers.add(cb);
  cb(entry.state);
  return () => entry.subscribers.delete(cb);
}

export function getReferencesState(docId: string): ReferencesState {
  return ensureEntry(docId).state;
}

/** Look up a single reference by its in-text citation number. */
export function getReference(
  docId: string,
  number: number,
): ReferenceEntry | null {
  const state = ensureEntry(docId).state;
  if (state.status !== "ready") return null;
  return state.byNumber.get(number) ?? null;
}

function settle(entry: Entry, status: ReferencesStatus, refs: ReferenceEntry[]): void {
  if (status === "complete") {
    const byNumber = new Map<number, ReferenceEntry>();
    for (const ref of refs) byNumber.set(ref.number, ref);
    setState(entry, { status: "ready", byNumber });
  } else if (status === "empty") {
    setState(entry, { status: "empty" });
  } else {
    setState(entry, { status: "error" });
  }
}

/**
 * Begin loading the document's references (idempotent — safe to call from
 * every page render). Polls while the backend parse is pending.
 */
export function loadReferences(docId: string): void {
  const entry = ensureEntry(docId);
  if (entry.started) return;
  entry.started = true;
  setState(entry, { status: "loading" });

  let polls = 0;
  const attempt = async (): Promise<void> => {
    let resp;
    try {
      resp = await fetchReferences(docId);
    } catch {
      setState(entry, { status: "error" });
      return;
    }
    if (resp.status === "pending") {
      if (polls++ >= MAX_POLLS) {
        setState(entry, { status: "error" });
        return;
      }
      setTimeout(() => void attempt(), POLL_INTERVAL_MS);
      return;
    }
    settle(entry, resp.status, resp.references);
  };

  void attempt();
}
