import {
  BLOCKED_TONE,
  BLOCKED_WORD,
  lastReported,
  type SemanticTone,
  WORKING_WORD,
} from "@/design/status";
import {
  type AgentSessionKind,
  isInteractiveSession,
  type SessionMetadata,
  type SilenceInput,
  sessionSilence,
  TERMINAL_SESSION_STATUSES,
} from "./types";

/**
 * The one word a live session is called by (ISS-1228): the sessions list, the session page, the
 * Agents runs tab, the Pipeline page and the dashboard all label a session here, so no two of them
 * call one session two things.
 */
export interface SessionWord {
  label: string;
  tone: SemanticTone;
  /** Silent past the one-minute line, so the label says what it last reported. */
  quiet: boolean;
  activity: string;
}

export interface SessionWordInput extends SilenceInput {
  runtimeState?: string | null;
  report?: { work: string } | null;
  kind?: AgentSessionKind | string | null;
  metadata?: SessionMetadata | null;
}

export const WAITING_FOR_INPUT_WORD = "Waiting for input";

const ACTIVITY: Record<string, { label: string; tone: SemanticTone }> = {
  starting: { label: "Starting", tone: "neutral" },
  working: { label: WORKING_WORD, tone: "active" },
  awaiting_input: { label: WAITING_FOR_INPUT_WORD, tone: "attention" },
  checkpointing: { label: "Checkpointing", tone: "neutral" },
  closed: { label: "Closing", tone: "neutral" },
};

const still = (label: string, tone: SemanticTone): SessionWord => ({
  label,
  tone,
  quiet: false,
  activity: label,
});

function isQuiet(session: SilenceInput, now: number): boolean {
  const { state } = sessionSilence(session, now);
  return state === "stale" || state === "reaping";
}

/**
 * What a session that has not ended is doing: its status first (Waiting for a box, Not started),
 * then the box's report of a block, then its runtime state, and Working where it states none. A
 * running session gone quiet says what it last reported instead.
 */
export function liveSessionWord(session: SessionWordInput, now: number): SessionWord {
  if (session.status === "queued") return still("Waiting for a box", "neutral");
  if (session.status === "idle") return still("Not started", "neutral");
  const activity = session.runtimeState ? ACTIVITY[session.runtimeState] : undefined;
  const doing =
    session.report?.work === "blocked"
      ? { label: BLOCKED_WORD, tone: BLOCKED_TONE }
      : (activity ?? { label: WORKING_WORD, tone: "active" as const });
  return isQuiet(session, now)
    ? { label: lastReported(doing.label), tone: "neutral", quiet: true, activity: doing.label }
    : still(doing.label, doing.tone);
}

/** The word for any session: `null` for one that has ended, and for a chat, whose idle is a turn
 *  awaiting its reply rather than a session not yet started. */
export function sessionWord(session: SessionWordInput, now: number): SessionWord | null {
  if (TERMINAL_SESSION_STATUSES.has(session.status)) return null;
  const named = session.kind !== undefined || session.metadata !== undefined;
  const kind = session.kind as AgentSessionKind | null | undefined;
  if (named && isInteractiveSession({ kind, metadata: session.metadata ?? null })) return null;
  return liveSessionWord(session, now);
}

/** Whether the session is one the Pipeline page calls Waiting for input. */
export function isWaitingForInput(session: SessionWordInput, now: number): boolean {
  return sessionWord(session, now)?.label === WAITING_FOR_INPUT_WORD;
}
