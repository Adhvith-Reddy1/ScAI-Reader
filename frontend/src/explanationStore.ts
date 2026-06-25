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
  streamChat,
  streamExplanation,
  streamRefine,
  type ChatTurn,
  type ExplanationKind,
} from "./api.ts";

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
    onError: (message, code) => {
      setState(entry, { status: "error", error: message, code });
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
    annotationId,
    { text, kind, content, messages: outgoing },
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
    annotationId,
    { text, kind, content: originalContent, messages: entry.chat.messages.slice() },
    {
      onDelta: (chunk) => {
        acc += chunk;
        // Show the rewrite arriving in the body (loading shimmer + partial).
        setState(entry, { status: "loading", content: acc, kind });
        entry.chat.refining = true;
        notify(entry);
      },
      onDone: (full) => {
        setState(entry, { status: "ready", content: full || acc, kind });
        entry.chat.refining = false;
        entry.refineAbort = undefined;
        notify(entry);
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
