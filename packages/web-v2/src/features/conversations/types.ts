// The durable conversation, as `/api/conversations` serves it — and the one
// derivation a screen needs over it.
//
// ISS-1004 step 5: these rows replace `SessionRow` on every conversation
// surface. A session is a RUN — it has a device, a status, a cost and turns that
// can be truncated and re-dispatched. A conversation is what was said, in order,
// with a decision beside each thing that was not.

export type ConversationAdapter = "web" | "widget" | "rocketchat" | "telegram";
export type ConversationShape = "direct" | "group";
export type ConversationMessageRole = "user" | "assistant" | "system";

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
  | "undetermined";

export interface ConversationRow {
  id: string;
  adapter: ConversationAdapter;
  externalId: string;
  shape: ConversationShape;
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
  /** Set INSTEAD of text: this turn ran and chose to say nothing. */
  silenceReason: string | null;
  createdAt: string;
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
export type SilenceDecision = Exclude<ConversationWindowDecision, "answered">;

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
}

/** What the thread renders, in the order it renders it. */
export type ThreadEntry =
  | { kind: "said"; key: string; message: ConversationMessage }
  | { kind: "silence"; key: string; decision: SilenceDecision; detail: unknown }
  | { kind: "pending"; key: string };

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
 * The thread, with every silence in the place it happened.
 */
// cm:guard this is criterion 28, and the two states it separates are told apart by DIFFERENT SHAPES rather than by wording: a `silence` entry is a window that closed on a decision, and a `pending` entry is a window that has not closed at all. Rendering an unclosed window as a silence — or omitting it — is how "nobody has answered yet" and "it read this and said nothing" become the same thing on screen, which is the exact confusion this criterion names.
// cm:guard a window whose decision is `answered` contributes NO entry, because the answer is already a message row below it.
export function threadEntries(
  messages: ConversationMessage[],
  windows: ConversationWindow[],
): ThreadEntry[] {
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
      else if (w.decision && w.decision !== "answered")
        out.push({ kind: "silence", key: w.id, decision: w.decision, detail: w.decisionDetail });
    }
  }
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
