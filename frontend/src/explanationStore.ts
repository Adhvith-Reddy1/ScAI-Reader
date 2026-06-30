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
  streamChat,
  streamExplanation,
  streamRefine,
  type ChatTurn,
  type ExplanationKind,
} from "./api.ts";
import {
  getExplanation as getCachedExplanation,
  putExplanation,
} from "./storage/localStore.ts";

export type ExplanationState =
  | { status: "idle" }
  | { status: "loading"; content: string; kind?: ExplanationKind }
  | { status: "ready"; content: string; kind: ExplanationKind }
  | { status: "error"; error: string; code?: string };

/**
 * The follow-up conversation a reader can have when the tooltip wasn't
 * enough. `streaming` is true while an assistant reply is arriving;
 * `refining` is true while the box text is being rewritten from the thread.
 */
export interface ChatThread {
  messages: ChatTurn[];
  streaming: boolean;
  refining: boolean;
  error: string | null;
}

type Subscriber = (state: ExplanationState) => void;

interface Entry {
  state: ExplanationState;
  chat: ChatThread;
  subscribers: Set<Subscriber>;
  abort?: () => void;
  chatAbort?: () => void;
  refineAbort?: () => void;
}

const entries = new Map<string, Entry>();

function freshChat(): ChatThread {
  return { messages: [], streaming: false, refining: false, error: null };
}

function ensureEntry(id: string): Entry {
  let entry = entries.get(id);
  if (!entry) {
    entry = {
      state: { status: "idle" },
      chat: freshChat(),
      subscribers: new Set(),
    };
    entries.set(id, entry);
  }
  return entry;
}

/** Re-broadcast the current explanation state. Used after chat mutations so
 * subscribers (the tooltip) re-render even though `state` didn't change. */
function notify(entry: Entry): void {
  for (const cb of entry.subscribers) cb(entry.state);
}

function setState(entry: Entry, next: ExplanationState): void {
  entry.state = next;
  notify(entry);
}

/**
 * Persist a completed explanation to the browser cache (Spec 02). Best-effort:
 * a failed cache write must never break the live tooltip, so errors are
 * swallowed. Refine writes the same `[docId, annotationId]` key, overwriting.
 */
function writeThroughCache(
  docId: string,
  annotationId: string,
  kind: ExplanationKind,
  text: string,
  content: string,
): void {
  void putExplanation({
    docId,
    annotationId,
    kind,
    text,
    content,
    status: "complete",
    updated_at: new Date().toISOString(),
  }).catch(() => {
    /* cache write is best-effort; the tooltip already has the content */
  });
}

function currentContentKind(entry: Entry): {
  content: string;
  kind: ExplanationKind;
} {
  const s = entry.state;
  if (s.status === "ready") return { content: s.content, kind: s.kind };
  if (s.status === "loading") {
    return { content: s.content, kind: s.kind ?? "explanation" };
  }
  return { content: "", kind: "explanation" };
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
 * Seed the store with a server-cached explanation. No-op if an entry is
 * already in `loading` or `ready` state — we never want to overwrite a
 * fresher local stream with a stale server payload.
 */
export function seedExplanation(
  annotationId: string,
  kind: ExplanationKind,
  content: string,
): void {
  const entry = ensureEntry(annotationId);
  if (entry.state.status === "loading" || entry.state.status === "ready") {
    return;
  }
  setState(entry, { status: "ready", content, kind });
}

/**
 * Kick off an explanation. Cache-first (Spec 06): a completed explanation in
 * IndexedDB renders instantly with no network/LLM call. On a miss, stream from
 * the stateless `/ai/explain` endpoint (keyed by `page` + `text`, not an
 * annotation id) and write the result through to the cache on completion.
 * If a stream is already in flight or completed, this is a no-op.
 */
export async function startExplanation(
  docId: string,
  annotationId: string,
  text: string,
  page: number,
): Promise<void> {
  const entry = ensureEntry(annotationId);
  if (entry.state.status === "loading" || entry.state.status === "ready") {
    return;
  }

  // Cache-first read. A hit short-circuits the network entirely.
  let cached;
  try {
    cached = await getCachedExplanation(docId, annotationId);
  } catch {
    cached = null;
  }
  // State may have advanced while we awaited the cache (e.g. another hover).
  if (entry.state.status !== "idle") return;
  if (cached && cached.status === "complete" && cached.content) {
    setState(entry, {
      status: "ready",
      content: cached.content,
      kind: cached.kind,
    });
    return;
  }

  setState(entry, { status: "loading", content: "" });

  entry.abort = streamExplanation(docId, page, text, {
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
      writeThroughCache(docId, annotationId, kind, text, full);
    },
    onError: (message, code) => {
      setState(entry, { status: "error", error: message, code });
      entry.abort = undefined;
    },
  });
}

/**
 * Lazily hydrate state from the browser cache (Spec 02) if we haven't seen this
 * annotation before. A complete cached explanation jumps straight to ready with
 * no network call; a miss returns false so the caller can start a fresh stream.
 */
export async function hydrateExplanation(
  docId: string,
  annotationId: string,
): Promise<boolean> {
  const entry = ensureEntry(annotationId);
  if (entry.state.status !== "idle") return true;

  let cached;
  try {
    cached = await getCachedExplanation(docId, annotationId);
  } catch {
    return false;
  }
  if (cached == null) return false;

  if (cached.status === "complete" && cached.content) {
    // Re-check: state may have advanced while the cache read was in flight.
    if (entry.state.status !== "idle") return true;
    setState(entry, {
      status: "ready",
      content: cached.content,
      kind: cached.kind,
    });
    return true;
  }
  return false;
}

/** The follow-up thread for a highlight. */
export function getChat(annotationId: string): ChatThread {
  return ensureEntry(annotationId).chat;
}

/**
 * Send a follow-up question. Appends the user's message and a placeholder
 * assistant turn, then streams the reply into that placeholder. No-op while a
 * reply or a refine is already in flight.
 */
export function sendChatMessage(
  docId: string,
  annotationId: string,
  text: string,
  userText: string,
  page: number,
): void {
  const trimmed = userText.trim();
  if (!trimmed) return;
  const entry = ensureEntry(annotationId);
  if (entry.chat.streaming || entry.chat.refining) return;

  const { content, kind } = currentContentKind(entry);
  entry.chat.messages.push({ role: "user", content: trimmed });
  // Messages we actually send: everything up to and including this question.
  const outgoing = entry.chat.messages.slice();
  entry.chat.messages.push({ role: "assistant", content: "" });
  entry.chat.streaming = true;
  entry.chat.error = null;
  notify(entry);

  const last = entry.chat.messages[entry.chat.messages.length - 1];
  entry.chatAbort = streamChat(
    docId,
    { text, kind, content, page, messages: outgoing },
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

/**
 * Rewrite the box text from the conversation. Streams the new definition/
 * explanation live into the body and, on success, leaves it as the ready
 * content (the server persists it too). On failure the original text is kept.
 */
export function refineFromChat(
  docId: string,
  annotationId: string,
  text: string,
  page: number,
): void {
  const entry = ensureEntry(annotationId);
  if (entry.chat.refining || entry.chat.streaming) return;
  if (entry.chat.messages.length === 0) return;

  const { content: originalContent, kind } = currentContentKind(entry);
  entry.chat.refining = true;
  entry.chat.error = null;
  notify(entry);

  let acc = "";
  entry.refineAbort = streamRefine(
    docId,
    {
      text,
      kind,
      content: originalContent,
      page,
      messages: entry.chat.messages.slice(),
    },
    {
      onDelta: (chunk) => {
        acc += chunk;
        // Show the rewrite arriving in the body (loading shimmer + partial).
        setState(entry, { status: "loading", content: acc, kind });
        entry.chat.refining = true;
        notify(entry);
      },
      onDone: (full) => {
        const finalText = full || acc;
        setState(entry, { status: "ready", content: finalText, kind });
        entry.chat.refining = false;
        entry.refineAbort = undefined;
        notify(entry);
        // Refine overwrites the cached explanation for this highlight.
        writeThroughCache(docId, annotationId, kind, text, finalText);
      },
      onError: (message) => {
        // Restore what the reader had — a failed rewrite shouldn't blank it.
        setState(entry, { status: "ready", content: originalContent, kind });
        entry.chat.refining = false;
        entry.chat.error = message;
        entry.refineAbort = undefined;
        notify(entry);
      },
    },
  );
}

/** Test-only: drop all per-annotation state. */
export function _resetForTest(): void {
  entries.clear();
}
