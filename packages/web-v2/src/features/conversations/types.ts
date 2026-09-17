// The durable conversation, as `/api/conversations` serves it — and the one
// derivation a screen needs over it.
//
// ISS-1004 step 5: these rows replace `SessionRow` on every conversation
// surface. A session is a RUN — it has a device, a status, a cost and turns that
// can be truncated and re-dispatched. A conversation is what was said, in order,
// with a decision beside each thing that was not.

// cm:guard the canonical entry's shape is IMPORTED from `features/session` rather than restated here,
// which is the whole of ISS-1029's result: one shape, one reader. A local copy of `CanonicalBlock` is
// the third spelling that issue exists to prevent (ISS-1078).
import type { CanonicalBlock, MessageEntry } from "@/features/session/types";

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
   * The ordered canonical blocks of this turn, where it has them.
   */
  // cm:guard `GET /api/conversations/:id` has returned these since ISS-1029 — `conversation-routes.ts`
  // serves the store's rows unprojected — and this type not naming them is what discarded them at the
  // boundary before any renderer could reach them. `null` is a row written through the text-only door:
  // every row before ISS-1029, and every reply whose turn produced no blocks. Those render from
  // `content`, and must keep doing so (ISS-1078).
  // cm:edge contract -> packages/core/src/conversations/store.ts — the same ordered blocks that module
  // types as `ContentBlock[] | null`.
  blocks?: CanonicalBlock[] | null;
  /** Set INSTEAD of text: this turn ran and chose to say nothing. */
  silenceReason: string | null;
  createdAt: string;
}

/**
 * A turn in flight, as the socket carries it.
 */
// cm:edge contract -> packages/core/src/assistant/conversation-progress.ts — `ConversationProgressFrame`
// is the other half; `rev` and `replaced` are settled there, and a rename on either side leaves a turn
// that streams to nowhere.
export interface ConversationProgressEntry {
  conversationId: string;
  /** Monotonic per turn. A frame below the highest already drawn is ignored. */
  rev: number;
  /** The growing canonical entry, under the id the settled row will carry. */
  entry: MessageEntry;
  /**
   * Set when the text that went out is NOT the prose these frames streamed.
   */
  // cm:guard the draft is DRAWN, marked as withdrawn, rather than swapped out from under the reader:
  // the door screen judges a whole reply after the turn ends, so streamed prose is unscreened prose and
  // a refusal replaces it. Showing that silently is the substitution this issue refused; the price and
  // the condition that ends it are on the `web-chat-reply` row in core's `messaging/doors.ts`.
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
  /**
   * Client-minted; never a server id, and never written anywhere.
   */
  // cm:guard this id is ALSO the `clientToken` the send carries, so `conversation.accepted` comes back
  // naming the row it belongs to. One id rather than two, because a second one would have to be
  // matched to this one anyway (ISS-1078).
  id: string;
  content: string;
  /**
   * `queued` is waiting its turn, `sending` is the request in flight, `sent` is a durable row the
   * room's own read has not caught up with yet, `failed` kept its words.
   */
  // cm:guard `sent` exists because the send does not RETURN until the agent's turn is over, so between
  // the server filing the message and the answer arriving there was no state to be in and the row read
  // "Sending…" for the length of a model turn. It is entered on the accepted frame and left when the
  // durable message appears in the room — not on the frame, because the frame carries ids and not the
  // message, and dropping the row there makes the question vanish from a cache that predates the send
  // (ISS-1078, plan consult F4).
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
  progress?: ConversationProgressEntry | null,
): ThreadEntry[] {
  // cm:guard a `handed-off` window is matched to its TURN by window id, and a window with no turn
  // behind it renders as `pending` rather than as nothing: the pair can be split for as long as the
  // read between them takes, and a gap there is the blank thread this rule exists to remove.
  const turnByWindow = new Map(agentTurns.map((t) => [t.windowId, t]));
  // cm:guard the frames are dropped once a stored row carries the SAME ENTRY ID, which is the whole of
  // criterion 11: `conversation.settled` clears the progress key, but `conversation.message` may land
  // first and write the durable row while the frames are still cached — and the two drawn together are
  // one answer on the screen twice. Reduced by id and never by text, because two turns that happen to
  // say the same thing are two turns (ISS-1078).
  // cm:guard this is also what ends a live turn whose settle frame was never delivered (criterion 16):
  // the progress key is written by the socket and fetched by nothing, so no refetch can clear it — the
  // stored row arriving is the only thing that says the turn is over, and this is where it says it.
  const live =
    progress && !messages.some((m) => m.id === progress.entry.id) ? progress : null;
  // cm:guard while a turn is arriving, its own window's "Nobody has answered this yet" is suppressed —
  // the collector closes the window when the turn ENDS, so a room read mid-turn holds an open window
  // and would print that line directly above the answer being typed (criterion 15). Only the LAST open
  // window is silenced: an older one still open is a turn nothing is arriving for, and that line is
  // exactly what it owes its reader.
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
        // cm:guard a DELIVERED turn contributes no entry, for the reason `answered` does not: its
        // reply is a message row below it, and a label beside it would print the same answer twice.
        if (turn && turn.state !== "delivered")
          out.push({ kind: "agent-turn", key: w.id, turn });
        else if (!turn) out.push({ kind: "pending", key: w.id });
      } else if (w.decision && w.decision !== "answered")
        out.push({ kind: "silence", key: w.id, decision: w.decision, detail: w.decisionDetail });
    }
  }
  // cm:guard the outbox SPLITS around the turn in flight, and the split is the whole of the order: a
  // row the server has confirmed (`sent`) is the question being answered, so it belongs above the
  // answer, while a row still queued or sending was typed ahead and has not been asked yet. Without
  // the split, a fresh room — whose stored read has not landed yet — drew the streaming answer ABOVE
  // the question it was answering. Watched on a local walk in Chrome, 2026-09-17 (ISS-1078).
  // cm:guard placed HERE rather than appended by the renderer, so this function stays the one
  // authority on what the thread's order is — the same reason the outbox is not interleaved by time.
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
