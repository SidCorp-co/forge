// A session's live turn (ISS-1268): its `agent-session.live` frames folded into one view, kept in
// the query cache under `liveTurnKey` by the event router and read by `features/session/live.ts`.
// Nothing here is stored; the turn's transcript replaces the streamed text once it lands.
import type { AgentSessionLiveItem } from "@forge/contracts/agent-session-live";

export interface LiveTurn {
  /** The message streaming now, or the last one that did. */
  messageId: string | null;
  text: string;
  thinking: string;
  /** Its text is still being generated. */
  streaming: boolean;
  /** When its last delta landed, ms; the stored transcript read after this holds it. */
  stoppedAt: number | null;
  status: "requesting" | "compacting" | null;
  retry: { attempt: number; maxRetries: number } | null;
  compacted: { preTokens: number; postTokens: number | null } | null;
  /** Held back until `resetsAt` (unix seconds). */
  rateLimit: { resetsAt: number | null } | null;
  context: { used: number | null; window: number | null };
  suggestion: string | null;
  /** The turn's `result` arrived. */
  ended: boolean;
}

const EMPTY: LiveTurn = {
  messageId: null,
  text: "",
  thinking: "",
  streaming: false,
  stoppedAt: null,
  status: null,
  retry: null,
  compacted: null,
  rateLimit: null,
  context: { used: null, window: null },
  suggestion: null,
  ended: false,
};

/** The session's own message items; a subagent's (a `parent`) nest under its call once stored. */
function own(item: AgentSessionLiveItem): boolean {
  return !("parent" in item) || item.parent === null;
}

/** Fold one frame's items into the live turn, in order. */
export function foldLive(prev: LiveTurn | undefined, items: readonly AgentSessionLiveItem[], now: number = Date.now()): LiveTurn {
  let s: LiveTurn = prev ?? EMPTY;
  for (const item of items) {
    if (!own(item)) continue;
    switch (item.kind) {
      case "message":
        s = { ...s, messageId: item.id, text: "", thinking: "", streaming: true, stoppedAt: null, retry: null, rateLimit: null, suggestion: null, ended: false };
        break;
      case "messageEnd":
        s = { ...s, streaming: false, stoppedAt: now };
        break;
      case "text":
        s = { ...s, text: s.text + item.text, streaming: true };
        break;
      case "thinking":
        s = { ...s, thinking: s.thinking + item.text, streaming: true };
        break;
      case "status":
        s = { ...s, status: item.status, ...(item.status === "compacting" ? { compacted: null } : {}) };
        break;
      case "retry":
        s = { ...s, retry: { attempt: item.attempt, maxRetries: item.maxRetries } };
        break;
      case "compacted":
        s = { ...s, status: null, compacted: { preTokens: item.preTokens, postTokens: item.postTokens } };
        break;
      case "rateLimit":
        s = { ...s, rateLimit: { resetsAt: item.resetsAt } };
        break;
      case "context":
        s = { ...s, context: { used: item.used ?? s.context.used, window: item.window ?? s.context.window } };
        break;
      case "ended":
        s = { ...s, ended: true, streaming: false, stoppedAt: s.stoppedAt ?? now, status: null, retry: null };
        break;
      case "suggestion":
        s = { ...s, suggestion: item.text };
        break;
    }
  }
  return s;
}

/** Where the live turn of a session is kept: never fetched, only set by the frames. */
export const liveTurnKey = (sessionId: string) => ["agent-session-live", sessionId] as const;

