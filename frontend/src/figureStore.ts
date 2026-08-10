/**
 * Per-figure explanation state, mirroring explanationStore but keyed by
 * (docId, figureId). Lets the card subscribe and re-render as tokens
 * stream in.
 */

import type { ChatTurn, FigureBBox } from "./api.ts";
import { streamFigureChat, streamFigureExplanation } from "./api.ts";
import {
  deleteExplanation,
  getExplanation as getCachedExplanation,
  putExplanation,
} from "./storage/localStore.ts";

export type FigureState =
  | { status: "idle" }
  | { status: "loading"; content: string }
  | { status: "ready"; content: string }
  | { status: "error"; error: string; code?: string };

/** The follow-up conversation a reader can have when the interpretation
 * wasn't enough — mirrors explanationStore's ChatThread. */
export interface FigureChatThread {
  messages: ChatTurn[];
  streaming: boolean;
  error: string | null;
}

type Subscriber = (state: FigureState) => void;

interface Entry {
  state: FigureState;
  chat: FigureChatThread;
  subscribers: Set<Subscriber>;
  abort?: () => void;
  chatAbort?: () => void;
}

const entries = new Map<string, Entry>();

function key(docId: string, figureId: string): string {
  return `${docId}::${figureId}`;
}

function freshChat(): FigureChatThread {
  return { messages: [], streaming: false, error: null };
}

function ensureEntry(docId: string, figureId: string): Entry {
  const k = key(docId, figureId);
  let entry = entries.get(k);
  if (!entry) {
    entry = {
      state: { status: "idle" },
      chat: freshChat(),
      subscribers: new Set(),
    };
    entries.set(k, entry);
  }
  return entry;
}

/** Re-broadcast the current figure state. Used after chat mutations too, so
 * subscribers (the card) re-render even though `state` didn't change. */
function notify(entry: Entry): void {
  for (const cb of entry.subscribers) cb(entry.state);
}

function setState(entry: Entry, next: FigureState): void {
  entry.state = next;
  notify(entry);
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

/**
 * Retry after an error — e.g. the reader just added their own API key to get
 * past the daily quota (see UserKeyPrompt.ts). `startFigureExplanation`
 * no-ops unless the entry is `idle`, so this resets it first.
 */
export function retryFigureExplanation(
  docId: string,
  figureId: string,
  page: number,
  label: string,
  bbox?: FigureBBox,
): void {
  const entry = ensureEntry(docId, figureId);
  if (entry.state.status !== "error") return;
  setState(entry, { status: "idle" });
  void startFigureExplanation(docId, figureId, page, label, bbox);
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

export async function startFigureExplanation(
  docId: string,
  figureId: string,
  page: number,
  label: string,
  bbox?: FigureBBox,
): Promise<void> {
  const entry = ensureEntry(docId, figureId);
  if (entry.state.status === "loading" || entry.state.status === "ready") {
    return;
  }

  // Cache-first: figure explanations are cached in the same `explanations`
  // store, reusing the `annotationId` slot for the figure id (Spec 06).
  let cached;
  try {
    cached = await getCachedExplanation(docId, figureId);
  } catch {
    cached = null;
  }
  if (entry.state.status !== "idle") return; // advanced while awaiting
  if (cached && cached.status === "complete" && cached.content) {
    setState(entry, { status: "ready", content: cached.content });
    return;
  }

  setState(entry, { status: "loading", content: "" });

  entry.abort = streamFigureExplanation(
    docId,
    figureId,
    page,
    label,
    {
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
        void putExplanation({
          docId,
          annotationId: figureId,
          kind: "explanation",
          text: label,
          content: full,
          status: "complete",
          updated_at: new Date().toISOString(),
        }).catch(() => {
          /* best-effort cache write */
        });
      },
      onError: (message, code) => {
        setState(entry, { status: "error", error: message, code });
        entry.abort = undefined;
      },
    },
    bbox,
  );
}

/** The follow-up thread for a figure. */
export function getFigureChat(docId: string, figureId: string): FigureChatThread {
  return ensureEntry(docId, figureId).chat;
}

/**
 * Figures have no annotation to delete (they're detected from the PDF, not
 * created by the reader) — "Delete" instead forgets this interpretation, both
 * the persisted cache and the in-memory state, so the next double-click
 * generates a fresh one instead of reusing the old answer.
 */
export async function forgetFigureExplanation(
  docId: string,
  figureId: string,
): Promise<void> {
  const entry = ensureEntry(docId, figureId);
  entry.abort?.();
  entry.chatAbort?.();
  entry.abort = undefined;
  entry.chatAbort = undefined;
  setState(entry, { status: "idle" });
  entry.chat = freshChat();
  notify(entry);
  try {
    await deleteExplanation(docId, figureId);
  } catch {
    /* best-effort cache clear */
  }
}

function currentFigureContent(entry: Entry): string {
  const s = entry.state;
  if (s.status === "ready" || s.status === "loading") return s.content;
  return "";
}

/**
 * Send a follow-up question about a figure. Appends the user's message and
 * a placeholder assistant turn, then streams the reply into that
 * placeholder. No-op while a reply is already in flight.
 */
export function sendFigureChatMessage(
  docId: string,
  figureId: string,
  page: number,
  label: string,
  userText: string,
  bbox?: FigureBBox,
): void {
  const trimmed = userText.trim();
  if (!trimmed) return;
  const entry = ensureEntry(docId, figureId);
  if (entry.chat.streaming) return;

  const content = currentFigureContent(entry);
  entry.chat.messages.push({ role: "user", content: trimmed });
  // Messages we actually send: everything up to and including this question.
  const outgoing = entry.chat.messages.slice();
  entry.chat.messages.push({ role: "assistant", content: "" });
  entry.chat.streaming = true;
  entry.chat.error = null;
  notify(entry);

  const last = entry.chat.messages[entry.chat.messages.length - 1];
  entry.chatAbort = streamFigureChat(
    docId,
    figureId,
    { page, label, bbox, content, messages: outgoing },
    {
      onDelta: (chunk) => {
        last.content += chunk;
        notify(entry);
      },
      onDone: (full) => {
        if (full) last.content = full;
        entry.chat.streaming = false;
        entry.chatAbort = undefined;
        notify(entry);
      },
      onError: (message) => {
        // Drop the empty placeholder so the thread doesn't show a blank reply.
        if (last.role === "assistant" && last.content === "") {
          entry.chat.messages.pop();
        }
        entry.chat.streaming = false;
        entry.chat.error = message;
        entry.chatAbort = undefined;
        notify(entry);
      },
    },
  );
}
