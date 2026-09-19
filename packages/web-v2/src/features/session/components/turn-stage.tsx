"use client";

import { Icon, Spinner } from "@/design";
import type { AgentSessionDisplayStatus } from "@/features/sessions/types";
import type { ConversationItem, RenderBlock } from "../types";

export type TurnStage = "working" | "responding" | "failed";

const LABEL: Record<TurnStage, string> = {
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
  return turnStageOf({
    live,
    failed: display === "failed",
    ...(fromMessages !== true && tail?.kind === "agent" ? { blocks: tail.blocks } : {}),
  });
}

/**
 * One line, one position, for the whole turn.
 */
export function TurnStage({ stage, elapsed }: { stage: TurnStage; elapsed?: string }) {
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
