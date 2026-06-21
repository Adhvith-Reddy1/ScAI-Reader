/**
 * Per-figure explanation state, mirroring explanationStore but keyed by
 * (docId, figureId). Lets the card subscribe and re-render as tokens
 * stream in.
 */

import { streamFigureExplanation } from "./api.ts";

export type FigureState =
  | { status: "idle" }
  | { status: "loading"; content: string }
  | { status: "ready"; content: string }
  | { status: "error"; error: string };

type Subscriber = (state: FigureState) => void;

interface Entry {
  state: FigureState;
  subscribers: Set<Subscriber>;
  abort?: () => void;
}

const entries = new Map<string, Entry>();

function key(docId: string, figureId: string): string {
  return `${docId}::${figureId}`;
}

function ensureEntry(docId: string, figureId: string): Entry {
  const k = key(docId, figureId);
  let entry = entries.get(k);
  if (!entry) {
    entry = { state: { status: "idle" }, subscribers: new Set() };
    entries.set(k, entry);
  }
  return entry;
}

function setState(entry: Entry, next: FigureState): void {
  entry.state = next;
  for (const cb of entry.subscribers) cb(next);
}

export function subscribeFigure(
  docId: string,
  figureId: string,
  cb: Subscriber,
): () => void {
  const entry = ensureEntry(docId, figureId);
  entry.subscribers.add(cb);
  cb(entry.state);
  return () => entry.subscribers.delete(cb);
}

export function getFigureState(docId: string, figureId: string): FigureState {
  return ensureEntry(docId, figureId).state;
}

export function seedFigure(
  docId: string,
  figureId: string,
  content: string,
): void {
  const entry = ensureEntry(docId, figureId);
  if (entry.state.status === "loading" || entry.state.status === "ready") {
    return;
  }
  setState(entry, { status: "ready", content });
}

export function startFigureExplanation(
  docId: string,
  figureId: string,
  page: number,
  label: string,
): void {
  const entry = ensureEntry(docId, figureId);
  if (entry.state.status === "loading" || entry.state.status === "ready") {
    return;
  }
  setState(entry, { status: "loading", content: "" });

  entry.abort = streamFigureExplanation(docId, figureId, page, label, {
    onDelta: (chunk) => {
      if (entry.state.status === "loading") {
        setState(entry, {
          ...entry.state,
          content: entry.state.content + chunk,
        });
      }
    },
    onDone: (full) => {
      setState(entry, { status: "ready", content: full });
      entry.abort = undefined;
    },
    onError: (message) => {
      setState(entry, { status: "error", error: message });
      entry.abort = undefined;
    },
  });
}
