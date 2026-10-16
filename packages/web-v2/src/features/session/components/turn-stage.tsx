"use client";

import { Icon, lastReported, SILENCE_TONE, SILENCE_WORD, Spinner, WORKING_WORD } from "@/design";
import { TONE_META } from "@/design/status";
import { formatElapsed } from "@/lib/utils/format";
import type { AgentSessionDisplayStatus } from "@/features/sessions/types";
import type { ConversationItem, RenderBlock } from "../types";

export type TurnStage = "working" | "responding" | "quiet" | "failed";

const LABEL: Record<Exclude<TurnStage, "quiet">, string> = {
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
 *  busy; `live` (answering or quiet) offers Stop; `quiet` holds a send. */
export interface SessionActivity {
  live: boolean;
  answering: boolean;
  quiet: boolean;
}

export function sessionActivity(display: AgentSessionDisplayStatus): SessionActivity {
  return {
    live: display === "running" || display === "stalled",
    answering: display === "running",
    quiet: display === "stalled",
  };
}

/** Why a quiet session's composer takes no message: a send starts a new turn on the box. */
export const QUIET_HOLD = "Sending waits until this session is heard from again.";

/** The composer's state on a session's page: busy only while answering or sending, held while quiet. */
export function sessionComposerState(
  display: AgentSessionDisplayStatus,
  sending: boolean,
): { busy: boolean; held?: string } {
  const { answering, quiet } = sessionActivity(display);
  return quiet && !sending ? { busy: false, held: QUIET_HOLD } : { busy: answering || sending };
}

/**
 * The stage a runner session's newest turn is in, off the facts the session screen already holds.
 */
export function sessionTurnStage({
  live,
  display,
  fromMessages,
  tail,
}: {
  /** The screen's own liveness, so which statuses are live is stated in one place and not two. */
  live: boolean;
  display: AgentSessionDisplayStatus;
  /** The transcript came from `agent_sessions.messages` rather than from turn rows (ISS-348). */
  fromMessages?: boolean;
  /** The thread's last item, whichever kind it is. */
  tail?: Pick<ConversationItem, "kind" | "blocks"> | undefined;
}): TurnStage | null {
  if (live && display === "stalled") return "quiet";
  return turnStageOf({
    live,
    failed: display === "failed",
    ...(fromMessages !== true && tail?.kind === "agent" ? { blocks: tail.blocks } : {}),
  });
}

/**
 * One line, one position, for the whole turn. A quiet session's line spins nothing and claims no
 * activity: it says what the turn last reported and how long ago that was.
 */
export function TurnStage({
  stage,
  elapsed,
  silentForMs,
}: {
  stage: TurnStage;
  elapsed?: string;
  /** How long a quiet session has gone unheard; read only on the `quiet` stage. */
  silentForMs?: number;
}) {
  if (stage === "quiet") {
    const since = silentForMs != null ? ` ${formatElapsed(Math.max(0, silentForMs))} ago` : "";
    return (
      <div
        data-testid="turn-stage"
        data-stage={stage}
        className="flex items-center gap-1.5"
        style={{ fontSize: "var(--text-12)", color: TONE_META[SILENCE_TONE].fg }}
        aria-live="polite"
      >
        <span className="flex h-[14px] w-[14px] flex-none items-center justify-center">
          <Icon name="clock" size={12} />
        </span>
        <span>{`${SILENCE_WORD} · ${lastReported(WORKING_WORD).toLowerCase()}${since}`}</span>
      </div>
    );
  }
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
        ) : (
          <Spinner size={12} />
        )}
      </span>
      <span>{LABEL[stage]}</span>
      {elapsed && <span className="font-mono">· {elapsed}</span>}
    </div>
  );
}
