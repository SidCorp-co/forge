// The durable conversation, as `/api/conversations` serves it — and the one
// derivation a screen needs over it.
//
// ISS-1004 step 5: these rows replace `SessionRow` on every conversation
// surface. A session is a RUN — it has a device, a status, a cost and turns that
// can be truncated and re-dispatched. A conversation is what was said, in order,
// with a decision beside each thing that was not.

import type { CanonicalBlock } from "@/features/session/types";

export type ConversationAdapter = "web" | "widget" | "rocketchat" | "telegram";
export type ConversationShape = "direct" | "group";
export type ConversationMessageRole = "user" | "assistant" | "system";

/**
 * What a room is talking to, picked in the composer and frozen by the first message.
 */
// cm:edge contract -> packages/core/src/db/schema-conversations.ts — the same two names the
// `conversations_mode_known` check constraint holds. A third added there and not here arrives as a
// value this file's unions cannot represent.
export type ConversationMode = "assistant" | "agent";

/** What a person is told about a runner-hosted turn while it is not yet an answer. */
export type AgentTurnState = "dispatched" | "running" | "delivered" | "failed";

export interface AgentTurn {
  windowId: string;
  sessionId: string;
  state: AgentTurnState;
  /** On `failed` only: which failure it was. */
  reason: string | null;
}

/**
 * Whether this room may still be opened in Agent mode, and why not where it may not.
 */
// cm:guard SERVED and never derived here, the same rule `canChangeMembership` follows: whether a box
// could take a turn is a fleet read the browser cannot make, and a composer that guessed would offer
// a control every press of which the server refuses (ISS-1039).
export interface AgentModeOffer {
  available: boolean;
  reason: string | null;
}

/**
 * Every way a window can close.
 */
// cm:edge contract -> packages/core/src/db/schema-conversations.ts — the same eight names the `conversation_windows_decision_known` check constraint holds; a ninth added there and not here renders as an unlabelled silence rather than failing.
export type ConversationWindowDecision =
  | "answered"
  | "nothing-to-say"
  | "guard-backoff"
  | "guard-agent-loop"
  | "guard-dormant"
  | "authority-refused"
  | "unreachable"
  | "undetermined"
  | "handed-off";

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

export interface ConversationMessage {
  id: string;
  seq: number;
  role: ConversationMessageRole;
  authorUserId: string | null;
  authorLabel: string | null;
  content: string;
  /**
   * The turn's ordered canonical blocks, or null on a row written through the text-only door.
   */
  // cm:guard the server has served these on every message since ISS-1029 and this type discarded
  // them at the boundary, so no renderer could reach them however it was written — which is why
  // criterion 19 is about the TYPE and the consumption rather than about a runtime change. Null is
  // a row from before that change and renders as its text (ISS-1078).
  blocks: CanonicalBlock[] | null;
  /** Set INSTEAD of text: this turn ran and chose to say nothing. */
  silenceReason: string | null;
  createdAt: string;
}

/**
 * A turn being written right now, as the socket carries it.
 */
// cm:guard the entry is the canonical `AgentMessage` core produces with the SAME accumulator the
// SSE chat surface uses, so it is read by `features/session/types.ts parseMessages` and this
// feature grows no formatter of its own — which is the drift ISS-1029 exists to prevent (ISS-1078).
export interface ConversationProgress {
  conversationId: string;
  /** The growing canonical entry; typed loosely because `parseMessages` takes `unknown`. */
  entry: unknown;
  /**
   * This frame is the REPLACEMENT for prose the reply screen refused.
   */
  // cm:guard drawn as a correction and never swapped in place: the amnesty that lets unjudged prose
  // reach the room is paid for by telling the reader the sentence they read was withdrawn, and a
  // silent substitution is exactly what that decision refuses (core `conversation-progress.ts`).
  replaced?: boolean;
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
// cm:guard `handed-off` is excluded as well as `answered`, and for the opposite reason: `answered`
// has a message row below it, and `handed-off` has a turn still being written that the thread
// renders as its own live entry. Rendering it as a silence would tell a person the agent read their
// question and said nothing, about a session that has not finished reading it (ISS-1039).
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
// cm:guard the SHAPE is part of it and not an afterthought: a direct room is read by the people in it and a group room by everyone holding a role on its projects, so a roster rendered without knowing which cannot tell a person what adding somebody there will do (ISS-1011).
export interface ConversationMembership {
  shape: ConversationShape;
  participants: ConversationParticipant[];
  /** The project ids, derived from the live agents — never chosen. */
  scope: string[];
  scopeProjects: ConversationProject[];
  /** Whether THIS caller may change who is in the room. */
  // cm:guard served, never inferred: the screen cannot compute it, because it turns on being a live person in the room AND holding a role on every project of a scope the screen does not decide. A client that guessed from the project role would offer the controls to somebody the server then refuses, which reads as a broken button rather than as a rule (ISS-1011).
  canChangeMembership: boolean;
}

export interface PersonCandidate {
  userId: string;
  displayName: string | null;
  email: string;
}

export interface HandleCandidate {
  /** The agent account, or null where this project has never needed one. */
  // cm:guard NULLABLE because core offers a project that has never been talked to under the name its agent will be given, and mints it on add. Typing this `string` made the add send `userId: undefined` and the advertised mint-on-add path unreachable from the screen (ISS-1011).
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
// cm:guard the outbox exists because `POST /conversations/:id/messages` does not return until the
// agent turn is OVER (core `assistant/conversation-send.ts` awaits `routeOneWebWindow`), so the
// authoritative messages cannot carry what a person just said until the answer arrives with it.
// Without a row of its own, pressing send left the text in the box and the thread unchanged for the
// whole turn, and the question then appeared stamped at the moment the answer did (ISS-1031).
export interface OutboxMessage {
  /** Client-minted; never a server id, and never written anywhere. */
  id: string;
  content: string;
  /**
   * `queued` is waiting its turn, `sending` is the request in flight, `accepted` is filed and
   * waiting for its durable copy, `failed` kept its words.
   */
  // cm:guard `accepted` is a fourth state and not the absence of one: the server has the message,
  // so "Sending…" would be a lie, but this tab's cache does not yet hold the row that replaces this
  // one — so the row stays, unlabelled, and is dropped when its own durable copy arrives rather
  // than at acceptance. Dropping it at acceptance makes the question vanish off the screen until a
  // later read brings it back (ISS-1078 criterion 2).
  state: "queued" | "sending" | "accepted" | "failed";
  /** Set on `failed` only — what the send was refused with. */
  error?: string;
}

/** What the thread renders, in the order it renders it. */
export type ThreadEntry =
  | { kind: "said"; key: string; message: ConversationMessage }
  | { kind: "silence"; key: string; decision: SilenceDecision; detail: unknown }
  | { kind: "pending"; key: string }
  | { kind: "agent-turn"; key: string; turn: AgentTurn }
  | { kind: "outbox"; key: string; item: OutboxMessage };

/**
 * Every decision that is a SILENCE, with the sentence a person reads for it.
 */
// cm:guard `answered` is absent deliberately and must stay absent: its window's text is a message row, so an entry for it would render the same answer twice — once as itself and once as a label saying it happened.
export const SILENCE_REASON: Record<SilenceDecision, string> = {
  "nothing-to-say": "The agent read this and had nothing to add.",
  "guard-backoff": "The agent is pacing itself here — it has had nothing to add for several turns.",
  "guard-agent-loop": "Left unanswered: the last few messages were agents repeating each other.",
  "guard-dormant": "Left unanswered: no person has spoken here for a long time.",
  "authority-refused": "The agent cannot act as whoever spoke here, so it did not answer.",
  unreachable: "The agent could not be reached, so this was never answered.",
  undetermined: "A reply was sent and never confirmed — the agent will not send it again.",
};

/**
 * What a person reads beside a runner-hosted turn, in each of its four states.
 */
// cm:guard four sentences and not one, which is the whole of ISS-1039's screen rule: a blank thread
// that means dispatched, running, delivered and failed alike is this feature failing in the field.
// `delivered` carries none, because the answer is a message row below it and a label saying it
// arrived would be the same fact twice.
export const AGENT_TURN_LABEL: Record<Exclude<AgentTurnState, "delivered">, string> = {
  dispatched: "Asked a paired box to take this — waiting for one to pick it up.",
  running: "A session is working on this on a paired box. The reply arrives here when it finishes.",
  failed: "This Agent turn did not produce an answer.",
};

/**
 * The thread, with every silence in the place it happened.
 */
// cm:guard this is criterion 28, and the two states it separates are told apart by DIFFERENT SHAPES rather than by wording: a `silence` entry is a window that closed on a decision, and a `pending` entry is a window that has not closed at all. Rendering an unclosed window as a silence — or omitting it — is how "nobody has answered yet" and "it read this and said nothing" become the same thing on screen, which is the exact confusion this criterion names.
// cm:guard a window whose decision is `answered` contributes NO entry, because the answer is already a message row below it.
// cm:guard the outbox is appended AFTER every stored row and never interleaved by time: an unsent
// message has no `seq`, and inventing one to sort it would put it above a row the server has already
// numbered. It is always the newest thing in the room, because it has not happened yet.
export function threadEntries(
  messages: ConversationMessage[],
  windows: ConversationWindow[],
  outbox: OutboxMessage[] = [],
  agentTurns: AgentTurn[] = [],
): ThreadEntry[] {
  // cm:guard a `handed-off` window is matched to its TURN by window id, and a window with no turn
  // behind it renders as `pending` rather than as nothing: the pair can be split for as long as the
  // read between them takes, and a gap there is the blank thread this rule exists to remove.
  const turnByWindow = new Map(agentTurns.map((t) => [t.windowId, t]));
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
      if (!w.closedAt) out.push({ kind: "pending", key: w.id });
      else if (w.decision === "handed-off") {
        const turn = turnByWindow.get(w.id);
        // cm:guard a DELIVERED turn contributes no entry, for the reason `answered` does not: its
        // reply is a message row below it, and a label beside it would print the same answer twice.
        if (turn && turn.state !== "delivered")
          out.push({ kind: "agent-turn", key: w.id, turn });
        else if (!turn) out.push({ kind: "pending", key: w.id });
      } else if (w.decision && w.decision !== "answered")
        out.push({ kind: "silence", key: w.id, decision: w.decision, detail: w.decisionDetail });
    }
  }
  for (const item of outbox) out.push({ kind: "outbox", key: item.id, item });
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
