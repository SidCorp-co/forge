
import { Icon, Spinner } from "@/design";
import type { AgentSessionDisplayStatus } from "@/features/sessions";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import type { ConversationItem, RenderBlock } from "../types";

export type TurnStage = "working" | "responding" | "failed";

const LABEL: Record<TurnStage, ProductCopyKey> = {
  working: "sessions.stage.working",
  responding: "sessions.stage.responding",
  failed: "sessions.stage.failed",
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
  truncated,
  tail,
}: {
  /** The screen's own liveness, so which statuses are live is stated in one place and not two. */
  live: boolean;
  display: AgentSessionDisplayStatus;
  /**
   * The loaded turns stop at the page cap, so the thread's last item is not the session's newest
   * turn: no live stage is drawn on it, only a failure, which is the session's and not the tail's.
   */
  truncated?: boolean;
  /** The thread's last item, whichever kind it is. */
  tail?: Pick<ConversationItem, "kind" | "blocks"> | undefined;
}): TurnStage | null {
  return turnStageOf({
    live: live && truncated !== true,
    failed: display === "failed",
    ...(tail?.kind === "agent" ? { blocks: tail.blocks } : {}),
  });
}

/**
 * One line, one position, for the whole turn.
 */
export function TurnStage({
  stage,
  elapsed,
  detail,
  status,
  context,
}: {
  stage: TurnStage;
  elapsed?: string;
  /** What a working turn is doing right now, said in place of the bare stage. */
  detail?: string | null;
  /** What holds a live turn up — a retry, a compaction, a rate limit — said in place of either (ISS-1268). */
  status?: string | null;
  /** How full the session's context is, a whole percent. */
  context?: number | null;
}) {
  const t = useCopy();
  return (
    <div
      data-testid="turn-stage"
      data-stage={stage}
      className="flex items-center gap-1.5 text-subtle"
      style={{ fontSize: "var(--text-12)" }}
      aria-live="polite"
    >
      <span className="flex h-3.5 w-3.5 flex-none items-center justify-center">
        {stage === "failed" ? (
          <Icon name="alert" size={12} className="text-danger" />
        ) : (
          <Spinner size={12} />
        )}
      </span>
      <span data-testid="turn-status">
        {stage !== "failed" && status ? status : stage === "working" && detail ? `${detail}…` : t(LABEL[stage])}
      </span>
      {elapsed && <span className="font-mono">· {elapsed}</span>}
      {context != null && stage !== "failed" && (
        <span data-testid="context-meter" className="ml-auto flex items-center gap-1.5" title={t("session.live.context", { n: context })}>
          <span className="block h-1 w-12 overflow-hidden rounded-pill bg-sunken" aria-hidden>
            <span className="block h-full bg-link" style={{ width: `${context}%` }} />
          </span>
          <span className="font-mono">{t("session.live.context", { n: context })}</span>
        </span>
      )}
    </div>
  );
}
