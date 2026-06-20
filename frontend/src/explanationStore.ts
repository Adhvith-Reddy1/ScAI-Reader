/**
 * Per-annotation explanation state, shared across all PageViews so the
 * hover tooltip can pick up where a streaming save left off.
 *
 * State machine:
 *   idle    -> we've never asked
 *   loading -> stream in flight (server response has not finished)
 *   ready   -> we have content
 *   error   -> something blew up; `error` holds the message
 */

import {
  getExplanation,
  streamExplanation,
  type ExplanationKind,
} from "./api.ts";

export type ExplanationState =
  | { status: "idle" }
  | { status: "loading"; content: string; kind?: ExplanationKind }
  | { status: "ready"; content: string; kind: ExplanationKind }
  | { status: "error"; error: string };

type Subscriber = (state: ExplanationState) => void;

interface Entry {
  state: ExplanationState;
  subscribers: Set<Subscriber>;
  abort?: () => void;
}

const entries = new Map<string, Entry>();

function ensureEntry(id: string): Entry {
  let entry = entries.get(id);
  if (!entry) {
    entry = { state: { status: "idle" }, subscribers: new Set() };
    entries.set(id, entry);
  }
  return entry;
}

function setState(entry: Entry, next: ExplanationState): void {
  entry.state = next;
  for (const cb of entry.subscribers) cb(next);
}

export function subscribeExplanation(
  annotationId: string,
  cb: Subscriber,
): () => void {
  const entry = ensureEntry(annotationId);
  entry.subscribers.add(cb);
  cb(entry.state);
  return () => entry.subscribers.delete(cb);
}

export function getExplanationState(annotationId: string): ExplanationState {
  return ensureEntry(annotationId).state;
}

/**
 * Kick off an explanation stream and broadcast progress to subscribers.
 * If one is already in flight or completed, this is a no-op.
 */
export function startExplanation(
  docId: string,
  annotationId: string,
  text: string,
): void {
  const entry = ensureEntry(annotationId);
  if (
    entry.state.status === "loading" ||
    entry.state.status === "ready"
  ) {
    return;
  }
  setState(entry, { status: "loading", content: "" });

  entry.abort = streamExplanation(docId, annotationId, text, {
    onMeta: (kind) => {
      if (entry.state.status === "loading") {
        setState(entry, { ...entry.state, kind });
      }
    },
    onDelta: (chunk) => {
      if (entry.state.status === "loading") {
        setState(entry, {
          ...entry.state,
          content: entry.state.content + chunk,
        });
      }
    },
    onDone: (full) => {
      const kind =
        entry.state.status === "loading"
          ? entry.state.kind ?? "explanation"
          : "explanation";
      setState(entry, { status: "ready", content: full, kind });
      entry.abort = undefined;
    },
    onError: (message) => {
      setState(entry, { status: "error", error: message });
      entry.abort = undefined;
    },
  });
}

/**
 * Lazily hydrate state from the backend if we haven't seen this annotation
 * before. If the backend has a complete explanation, jump straight to ready.
 * If pending, we'll wait — the caller can decide to startExplanation.
 *
 * Returns true if state is now ready or loading, false if there's nothing
 * stored server-side either.
 */
export async function hydrateExplanation(
  docId: string,
  annotationId: string,
): Promise<boolean> {
  const entry = ensureEntry(annotationId);
  if (entry.state.status !== "idle") return true;

  let server;
  try {
    server = await getExplanation(docId, annotationId);
  } catch {
    return false;
  }
  if (server == null) return false;

  if (server.status === "complete" && server.content) {
    setState(entry, {
      status: "ready",
      content: server.content,
      kind: server.kind,
    });
    return true;
  }
  if (server.status === "error") {
    setState(entry, {
      status: "error",
      error: server.error ?? "unknown error",
    });
    return true;
  }
  // pending — caller may start a fresh stream
  return false;
}
