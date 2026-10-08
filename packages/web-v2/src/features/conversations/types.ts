
import { isAssistantTurnFailureCode } from "@forge/contracts/conversations";
import type { OnboardingStatus, QuestionnaireView } from "@forge/contracts/onboarding";
import { type CanonicalBlock, type MessageEntry, parseMessages, type RenderBlock } from "@/features/session/types";
import { type Copy, type ProductCopyKey, productCopy } from "@/lib/i18n/product-copy";
import { formatDateTime } from "@/lib/i18n/format";

export type ConversationAdapter = "web" | "widget" | "rocketchat" | "telegram";
export type ConversationShape = "direct" | "group";
export type ConversationMessageRole = "user" | "assistant" | "system";

export type ConversationMode = "assistant" | "agent";

export type AgentTurnState = "dispatched" | "running" | "delivered" | "held" | "failed";

export interface AgentTurn {
  windowId: string;
  sessionId: string;
  state: AgentTurnState;
  reason: string | null;
  /**
   * On a failed turn: the next step its own cause calls for (a box that cannot confine a chat is not
   * answered by asking again). Null keeps the generic step.
   */
  nextStep: string | null;
  /**
   * The reply the reply check held: why, and — for the person it answered, null for anyone else —
   * the text itself and the visual blocks the session drew for it, held with it.
   */
  held?: {
    reason: string;
    reply: string | null;
    blocks?: { type: "visual"; visual?: unknown; run?: unknown }[] | null;
  } | null;
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
  ecosystemId: string | null;
  pinned?: boolean;
  requirementId?: string | null;
  /** The thread's kind and badge (ISS-63). */
  kind?: "onboarding" | "requirement" | "first_requirements" | null;
  threadStatus?: OnboardingStatus | null;
  subjectKey?: string | null;
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

/** A tool the turn ran, as a reader who did not ask is shown it: its name, and its time once done. */
export interface ConversationRoomTool {
  id: string;
  name: string;
  done: boolean;
  durationMs?: number;
  isError?: true;
}

/**
 * A turn in flight, as the socket carries it, in the view core chose for this reader (REQ-32
 * criterion 6). Only the person the turn answers is sent the `asker` view, with the draft and the
 * tool calls in full; everyone else is sent the `room` view, which carries no text and no tool
 * input or output — the web does not hide them, it never receives them.
 */
export interface ConversationProgressEntry {
  conversationId: string;
  /** Monotonic per turn. A frame below the highest already drawn is ignored. */
  rev: number;
  view: "asker" | "room";
  /** The growing canonical entry, under the id the settled row will carry; empty in the room's view. */
  entry: MessageEntry;
  /** The room's view of the tools the turn ran. */
  tools?: ConversationRoomTool[];
  /** Absent while the text streamed is a draft the reply check has not passed. */
  verdict?: "checked" | "withheld";
  /**
   * Set when the text that went out is NOT the prose these frames streamed.
   */
  replaced?: { draft: string };
}

/**
 * The render blocks a live turn's stage line reads: the entry's own for the asker, and for the room
 * the tools by name alone — a done one with an empty result, a running one with none.
 */
export function liveRenderBlocks(progress: ConversationProgressEntry): RenderBlock[] | undefined {
  if (progress.view !== "room") return parseMessages([progress.entry])[0]?.blocks;
  return (progress.tools ?? []).map((tool) => ({
    type: "tool" as const,
    tool: { id: tool.id, name: tool.name, ...(tool.done ? { result: "" } : {}) },
  }));
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
  questionnaires?: QuestionnaireView[];
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
  | { kind: "handed"; key: string; reason: string }
  | { kind: "pending"; key: string }
  | { kind: "agent-turn"; key: string; turn: AgentTurn }
  | { kind: "progress"; key: string; progress: ConversationProgressEntry }
  | { kind: "outbox"; key: string; item: OutboxMessage };

/**
 * Every decision that is a SILENCE, with the sentence a person reads for it.
 */
export const SILENCE_REASON: Record<SilenceDecision, ProductCopyKey> = {
  "nothing-to-say": "conversations.silence.nothing-to-say",
  "guard-backoff": "conversations.silence.guard-backoff",
  "guard-agent-loop": "conversations.silence.guard-agent-loop",
  "guard-dormant": "conversations.silence.guard-dormant",
  "authority-refused": "conversations.silence.authority-refused",
  unreachable: "conversations.silence.unreachable",
  undetermined: "conversations.silence.undetermined",
  stopped: "conversations.silence.stopped",
};

/**
 * The sentence for a silence whose window named why the agent stayed out of a group room (core
 * `window-decision.ts:hearGroup`), or the decision's own sentence when it named nothing more.
 */
export function silenceDetailSentence(decision: SilenceDecision, detail: unknown, language = "en"): string {
  const t = productCopy(language);
  const d = (detail ?? {}) as { reason?: unknown; by?: unknown; since?: unknown };
  const by = typeof d.by === "string" && d.by ? t("conversations.silence.by", { who: d.by }) : "";
  const when =
    typeof d.since === "string" && !Number.isNaN(Date.parse(d.since))
      ? t("conversations.silence.since", { when: formatDateTime(d.since, language) })
      : "";
  switch (d.reason) {
    case "asked-to-stop":
      return t("conversations.silence.askedToStop", { by });
    case "quiet-until-mentioned":
      return t("conversations.silence.quietUntilMentioned", { when, by });
    case "addressed-to-person":
      return t("conversations.silence.addressedToPerson");
    case "not-mentioned":
      return t("conversations.silence.notMentioned");
    default:
      return t(SILENCE_REASON[decision]);
  }
}

/**
 * A reply core composed and could not deliver (`assistant/window-decision.ts:routedOutcome`): the
 * window keeps the text and a coded reader-facing reason, so the thread shows both instead of the
 * generic sentence. A reason with no `code` was written before reasons were coded and may hold a
 * driver error with other readers' ids, so it is never shown.
 */
export function undeliveredReplyOf(detail: unknown, t: Copy = productCopy()): { reason: string; reply: string } | null {
  if (!detail || typeof detail !== "object") return null;
  const { code, reason, undeliveredReply } = detail as {
    code?: unknown;
    reason?: unknown;
    undeliveredReply?: unknown;
  };
  if (typeof undeliveredReply !== "string") return null;
  const coded = typeof code === "string" && typeof reason === "string";
  return { reason: coded ? reason : t("conversations.thread.noReason"), reply: undeliveredReply };
}

/**
 * What a person reads beside a runner-hosted turn, in each of its four states.
 */
export const AGENT_TURN_LABEL: Record<Exclude<AgentTurnState, "delivered">, ProductCopyKey> = {
  dispatched: "conversations.agentTurn.dispatched",
  running: "conversations.agentTurn.running",
  held: "conversations.agentTurn.held",
  failed: "conversations.agentTurn.failed",
};

/** The reason a window was handed to the onboarding job (core `toOnboardingJob`), or null for any other hand-off. */
function toOnboardingJob(detail: unknown): string | null {
  const d = detail as { handedTo?: unknown; reason?: unknown } | null;
  return d?.handedTo === "onboarding-job" && typeof d.reason === "string" ? d.reason : null;
}

/**
 * Whether the window's status reached the room: then that message is the one statement the reader
 * gets, and the window's own sentence would say the same thing a second time, or contradict it.
 */
function statusPosted(detail: unknown): boolean {
  const status = (detail as { status?: { delivered?: unknown } } | null)?.status;
  return status?.delivered === true;
}

/** A failed turn's coded reason (core `routedOutcome`, decision unreachable), or null. */
export function turnFailureOf(detail: unknown): { code: string; reason: string } | null {
  const d = detail as { code?: unknown; reason?: unknown } | null;
  return isAssistantTurnFailureCode(d?.code) && typeof d?.reason === "string" ? { code: d.code, reason: d.reason } : null;
}

const SILENCE_ROW_REASON: Record<string, ProductCopyKey> = {
  "nothing-to-say": "conversations.silenceRow.nothing-to-say",
  "not-mentioned": "conversations.silenceRow.not-mentioned",
  "tool-not-called": "conversations.silenceRow.tool-not-called",
  "empty-reply": "conversations.silenceRow.empty-reply",
  "screen-refused": "conversations.silenceRow.screen-refused",
};

/** The sentence for a silence a turn recorded: one it chose, or a generic line for a reason no reader is shown. */
export function silenceSentence(reason: string, t: Copy = productCopy()): string {
  return t(SILENCE_ROW_REASON[reason] ?? "conversations.silenceRow.generic");
}

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
      else if (w.decision === "handed-off" && toOnboardingJob(w.decisionDetail)) {
        out.push({ kind: "handed", key: w.id, reason: toOnboardingJob(w.decisionDetail) as string });
      } else if (w.decision === "handed-off") {
        const turn = turnByWindow.get(w.id);
        if (turn && turn.state !== "delivered")
          out.push({ kind: "agent-turn", key: w.id, turn });
        else if (!turn) out.push({ kind: "pending", key: w.id });
      } else if (w.decision && w.decision !== "answered" && !statusPosted(w.decisionDetail))
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
/** A room's name: its title, else its first words, else `untitled` (the caller's words for a room with neither). */
export function conversationTitle(row: ConversationRow, firstSaid?: string | null, untitled = "New conversation"): string {
  const named = row.title?.trim();
  if (named) return named;
  const said = firstSaid?.trim();
  if (said) return said.length > 60 ? `${said.slice(0, 60)}…` : said;
  return untitled;
}
