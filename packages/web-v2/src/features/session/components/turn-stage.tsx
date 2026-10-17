"use client";

import { BLOCKED_TONE, Icon, lastReported, SILENCE_TONE, Spinner, WORKING_WORD } from "@/design";
import { TONE_META } from "@/design/status";
import { formatElapsed } from "@/lib/utils/format";
import { WAITING_FOR_INPUT_WORD } from "@/features/sessions/session-word";
import { blockedText, quietLastReportedText } from "@/features/sessions/status-sentences";
import { type AgentSessionDisplayStatus, isLiveDisplay } from "@/features/sessions/types";
import type { ConversationItem, RenderBlock } from "../types";

export type TurnStage = "working" | "responding" | "quiet" | "blocked" | "failed";

const LABEL: Record<Exclude<TurnStage, "quiet" | "blocked">, string> = {
  working: "Working…",
  responding: "Responding…",
  failed: "Failed",
};

/**
 * The stage a turn is in, or nothing at all where the turn is not doing anything.
 */
export function turnStageOf({
  live,
  failed,
  blocks,
}: {
  /** The run is producing this turn right now. */
  live?: boolean;
  /** The run this turn belongs to failed. */
  failed?: boolean;
  /** The live turn's render blocks, in order — the tail decides which live stage it is. */
  blocks?: readonly RenderBlock[] | undefined;
}): TurnStage | null {
  if (failed === true) return "failed";
  if (live !== true) return null;
  return blocks?.[blocks.length - 1]?.type === "text" ? "responding" : "working";
}

/** What a session's page may draw. Only `answering` spins, streams a caret or makes the composer
 *  busy; `live` (answering, quiet or blocked) offers Stop; `quiet` and `blocked` hold a send. */
export interface SessionActivity {
  live: boolean;
  answering: boolean;
  quiet: boolean;
  blocked: boolean;
}

export function sessionActivity(display: AgentSessionDisplayStatus): SessionActivity {
  return {
    live: isLiveDisplay(display),
    answering: display === "running",
    quiet: display === "stalled",
    blocked: display === "blocked",
  };
}

/** Why a quiet session's composer takes no message: a send starts a new turn on the box. */
export const QUIET_HOLD = "Sending waits until this session is heard from again.";
export const BLOCKED_HOLD = "Sending waits until this session is no longer blocked.";

/** The composer's state on a session's page: busy only while answering or sending, else held while quiet or blocked. */
export function sessionComposerState(
  display: AgentSessionDisplayStatus,
  sending: boolean,
  waitingForInput = false,
): { busy: boolean; held?: string } {
  const { answering, quiet, blocked } = sessionActivity(display);
  if (sending) return { busy: true };
  if (quiet) return { busy: false, held: QUIET_HOLD };
  if (blocked) return { busy: false, held: BLOCKED_HOLD };
  return { busy: answering && !waitingForInput };
}

/**
 * The stage a runner session's newest turn is in, off the facts the session screen already holds.
 */
export function sessionTurnStage({
  live,
  display,
  failureReason,
  fromMessages,
  tail,
}: {
  /** Why core ended the session: a person's stop draws no line, as a cancelled session does. */
  failureReason?: string | null;
  /** The screen's own liveness, so which statuses are live is stated in one place and not two. */
  live: boolean;
  display: AgentSessionDisplayStatus;
  /** The transcript came from `agent_sessions.messages` rather than from turn rows (ISS-348). */
  fromMessages?: boolean;
  /** The thread's last item, whichever kind it is. */
  tail?: Pick<ConversationItem, "kind" | "blocks"> | undefined;
}): TurnStage | null {
  if (live && display === "stalled") return "quiet";
  if (live && display === "blocked") return "blocked";
  if (display === "failed" && failureReason === "user_cancelled") return null;
  return turnStageOf({
    live,
    failed: display === "failed",
    ...(fromMessages !== true && tail?.kind === "agent" ? { blocks: tail.blocks } : {}),
  });
}

/**
 * One line, one position, for the whole turn. A quiet session's line spins nothing and claims no
 * activity: it says what the turn last reported and how long ago that was. A blocked one spins
 * nothing either, and says what its box reports it waits on.
 */
export function TurnStage({
  stage,
  elapsed,
  silentForMs,
  reported = WORKING_WORD,
  waitingOn,
  activity,
}: {
  stage: TurnStage;
  elapsed?: string;
  /** How long a quiet session has gone unheard; read only on the `quiet` stage. */
  silentForMs?: number;
  /** What a quiet session was last reported doing; read only on the `quiet` stage. */
  reported?: string;
  /** Who can end a blocked session's wait and what it waits on, in the box's words; `blocked` only. */
  waitingOn?: string;
  /** The session's word (`sessionWord`), which a `working` line says in place of Working. */
  activity?: string;
}) {
  if (stage === "quiet" || stage === "blocked") {
    const quiet = stage === "quiet";
    const ago = quiet && silentForMs != null ? `${formatElapsed(Math.max(0, silentForMs))} ago` : null;
    const text = quiet ? quietLastReportedText(lastReported(reported), ago) : blockedText(waitingOn);
    return (
      <div
        data-testid="turn-stage"
        data-stage={stage}
        className="flex items-center gap-1.5"
        style={{ fontSize: "var(--text-12)", color: TONE_META[quiet ? SILENCE_TONE : BLOCKED_TONE].fg }}
        aria-live="polite"
      >
        <span className="flex h-[14px] w-[14px] flex-none items-center justify-center">
          <Icon name={quiet ? "quiet" : "pause"} size={12} />
        </span>
        <span>{text}</span>
      </div>
    );
  }
  const named = stage === "working" && activity !== undefined && activity !== WORKING_WORD;
  const waitingForInput = named && activity === WAITING_FOR_INPUT_WORD;
  const label = named ? (waitingForInput ? activity : `${activity}…`) : LABEL[stage];
  return (
    <div
      data-testid="turn-stage"
      data-stage={stage}
      className="flex items-center gap-1.5 text-subtle"
      style={{ fontSize: "var(--text-12)" }}
      aria-live="polite"
    >
      <span className="flex h-[14px] w-[14px] flex-none items-center justify-center">
        {stage === "failed" ? (
          <Icon name="alert" size={12} className="text-danger" />
        ) : waitingForInput ? (
          <Icon name="pause" size={12} />
        ) : (
          <Spinner size={12} />
        )}
      </span>
      <span>{label}</span>
      {elapsed && <span className="font-mono">· {elapsed}</span>}
    </div>
  );
}
