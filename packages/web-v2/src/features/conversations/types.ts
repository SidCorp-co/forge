
import type { CanonicalBlock, MessageEntry } from "@/features/session/types";

export type ConversationAdapter = "web" | "widget" | "rocketchat" | "telegram";
export type ConversationShape = "direct" | "group";
export type ConversationMessageRole = "user" | "assistant" | "system";

export type ConversationMode = "assistant" | "agent";

export type AgentTurnState = "dispatched" | "running" | "delivered" | "failed";

export interface AgentTurn {
  windowId: string;
  sessionId: string;
  state: AgentTurnState;
  reason: string | null;
}

export interface AgentModeOffer {
  available: boolean;
  reason: string | null;
}

/**
 * Every way a window can close.
 */
export type ConversationWindowDecision =
  | "answered"
  | "nothing-to-say"
  | "guard-backoff"
  | "guard-agent-loop"
  | "guard-dormant"
  | "authority-refused"
  | "unreachable"
  | "undetermined"
  | "handed-off"
  | "stopped";

export interface ConversationRow {
  id: string;
  adapter: ConversationAdapter;
  externalId: string;
  shape: ConversationShape;
  /** Null while nobody has settled it — the one state in which the composer still offers the pick. */
  mode: ConversationMode | null;
  title: string | null;
  updatedAt: string;
  /** Set = archived: out of the default list, still readable, still restorable (ISS-1028). */
  archivedAt: string | null;
}

export interface ConversationImage {
  name: string;
  mime: string;
  ref: string;
}

export interface ConversationMessage {
  id: string;
  seq: number;
  role: ConversationMessageRole;
  authorUserId: string | null;
  authorLabel: string | null;
  content: string;
  images?: ConversationImage[];
  /**
   * The ordered canonical blocks of this turn, where it has them.
   */
  blocks?: CanonicalBlock[] | null;
  /** Set INSTEAD of text: this turn ran and chose to say nothing. */
  silenceReason: string | null;
  createdAt: string;
}

/**
 * A turn in flight, as the socket carries it.
 */
export interface ConversationProgressEntry {
  conversationId: string;
  /** Monotonic per turn. A frame below the highest already drawn is ignored. */
  rev: number;
  /** The growing canonical entry, under the id the settled row will carry. */
  entry: MessageEntry;
  /**
   * Set when the text that went out is NOT the prose these frames streamed.
   */
  replaced?: { draft: string };
}

export interface ConversationWindow {
  id: string;
  firstSeq: number;
  lastSeq: number;
  closedAt: string | null;
  decision: ConversationWindowDecision | null;
  decisionDetail: unknown;
}

/** Every decision that is NOT an answer — which is every decision a person reads a reason for. */
export type SilenceDecision = Exclude<ConversationWindowDecision, "answered" | "handed-off">;

export interface ConversationParticipant {
  id: string;
  kind: "person" | "handle";
  userId: string | null;
  /** The project a handle brings to the room; null for a person. */
  projectId: string | null;
  label: string | null;
  /** What to print: the address for an agent, the account's own name for a person. */
  displayName: string | null;
  reachable: boolean | null;
}

/** A project in a room's derived scope, named so a screen can say which it is. */
export interface ConversationProject {
  id: string;
  name: string;
  slug: string;
}

/**
 * A room's membership, as every membership call answers with it.
 */
export interface ConversationMembership {
  shape: ConversationShape;
  participants: ConversationParticipant[];
  /** The project ids, derived from the live agents — never chosen. */
  scope: string[];
  scopeProjects: ConversationProject[];
  /** Whether THIS caller may change who is in the room. */
  canChangeMembership: boolean;
}

export interface PersonCandidate {
  userId: string;
  displayName: string | null;
  email: string;
}

export interface HandleCandidate {
  /** The agent account, or null where this project has never needed one. */
  userId: string | null;
  handle: string;
  project: ConversationProject;
  /** Who in the room today would lose it if this agent joined — already named. */
  losesReaders: string[];
}

export interface ConversationCandidates {
  people: PersonCandidate[];
  handles: HandleCandidate[];
}

export interface ConversationDetail extends ConversationRow, ConversationMembership {
  messages: ConversationMessage[];
  windows: ConversationWindow[];
  agentMode: AgentModeOffer;
  agentTurns: AgentTurn[];
}

/**
 * A message this browser has accepted and the server has not confirmed.
 */
export interface OutboxMessage {
  /**
   * Client-minted; never a server id, and never written anywhere.
   */
  id: string;
  content: string;
  /** Staged in the composer, uploaded when this message is actually sent. */
  files?: File[];
  state: "queued" | "sending" | "sent" | "failed";
  /** Set on `failed` only — what the send was refused with. */
  error?: string;
  /** Set on `sent` — the durable row this became, so the thread knows when to let go of it. */
  messageId?: string;
}

/** What the thread renders, in the order it renders it. */
export type ThreadEntry =
  | { kind: "said"; key: string; message: ConversationMessage }
  | { kind: "silence"; key: string; decision: SilenceDecision; detail: unknown }
  | { kind: "pending"; key: string }
  | { kind: "agent-turn"; key: string; turn: AgentTurn }
  | { kind: "progress"; key: string; progress: ConversationProgressEntry }
  | { kind: "outbox"; key: string; item: OutboxMessage };

/**
 * Every decision that is a SILENCE, with the sentence a person reads for it.
 */
export const SILENCE_REASON: Record<SilenceDecision, string> = {
  "nothing-to-say": "The agent read this and had nothing to add.",
  "guard-backoff": "The agent is pacing itself here — it has had nothing to add for several turns.",
  "guard-agent-loop": "Left unanswered: the last few messages were agents repeating each other.",
  "guard-dormant": "Left unanswered: no person has spoken here for a long time.",
  "authority-refused": "The agent cannot act as whoever spoke here, so it did not answer.",
  unreachable: "The agent could not be reached, so this was never answered.",
  undetermined: "A reply was sent and never confirmed — the agent will not send it again.",
  stopped: "You stopped this answer, so the agent never finished it.",
};

/**
 * What a person reads beside a runner-hosted turn, in each of its four states.
 */
export const AGENT_TURN_LABEL: Record<Exclude<AgentTurnState, "delivered">, string> = {
  dispatched: "Asked a paired box to take this — waiting for one to pick it up.",
  running: "A session is working on this on a paired box. The reply arrives here when it finishes.",
  failed: "This Agent turn did not produce an answer.",
};

/**
 * The thread, with every silence in the place it happened.
 */
export function threadEntries(
  messages: ConversationMessage[],
  windows: ConversationWindow[],
  outbox: OutboxMessage[] = [],
  agentTurns: AgentTurn[] = [],
  progress?: ConversationProgressEntry | null,
): ThreadEntry[] {
  const turnByWindow = new Map(agentTurns.map((t) => [t.windowId, t]));
  const live =
    progress && !messages.some((m) => m.id === progress.entry.id) ? progress : null;
  const arriving = live
    ? [...windows].filter((w) => !w.closedAt).sort((a, b) => a.lastSeq - b.lastSeq).at(-1)?.id
    : undefined;
  const bySeq = new Map<number, ConversationWindow[]>();
  for (const w of windows) {
    const at = bySeq.get(w.lastSeq) ?? [];
    at.push(w);
    bySeq.set(w.lastSeq, at);
  }
  const out: ThreadEntry[] = [];
  const ordered = [...messages].sort((a, b) => a.seq - b.seq);
  for (const message of ordered) {
    out.push({ kind: "said", key: message.id, message });
    for (const w of bySeq.get(message.seq) ?? []) {
      if (!w.closedAt) {
        if (w.id !== arriving) out.push({ kind: "pending", key: w.id });
      }
      else if (w.decision === "handed-off") {
        const turn = turnByWindow.get(w.id);
        if (turn && turn.state !== "delivered")
          out.push({ kind: "agent-turn", key: w.id, turn });
        else if (!turn) out.push({ kind: "pending", key: w.id });
      } else if (w.decision && w.decision !== "answered")
        out.push({ kind: "silence", key: w.id, decision: w.decision, detail: w.decisionDetail });
    }
  }
  const asked = outbox.filter((m) => m.state === "sent");
  const unasked = outbox.filter((m) => m.state !== "sent");
  for (const item of asked) out.push({ kind: "outbox", key: item.id, item });
  if (live) out.push({ kind: "progress", key: `progress-${live.entry.id}`, progress: live });
  for (const item of unasked) out.push({ kind: "outbox", key: item.id, item });
  return out;
}

/** A conversation's name, or the first thing said in it. */
export function conversationTitle(row: ConversationRow, firstSaid?: string | null): string {
  const named = row.title?.trim();
  if (named) return named;
  const said = firstSaid?.trim();
  if (said) return said.length > 60 ? `${said.slice(0, 60)}…` : said;
  return "New conversation";
}
