
// The turns a thread shows while they run: the viewer's own live answer, the room's, and an agent run with its held reply.

import { useState } from "react";
import { Icon, keyedByContent } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { executionFactsIn, runFactsIn, VisualBlockProvider, VisualBlockView } from "@/features/visual-blocks";
import { type MessageEntry } from "@/features/session";
import { AGENT_TURN_LABEL, type AgentTurn, type AgentTurnState, type ConversationProgressEntry } from "../types";


/** Whether an entry carries prose — in the asker's view before the verdict, a draft. */
function carriesProse(entry: MessageEntry): boolean {
  return (entry.blocks ?? []).some((b) => b.type === "text" && !!b.text) || (typeof entry.content === "string" && entry.content.trim() !== "");
}

import { AssistantTurn, ReplacedDraftNote } from "./assistant-turn";


/**
 * The turn running right now, in the view core sent this reader. The person it answers sees the
 * draft as it streams, labelled unchecked until the verdict replaces it with the reply or takes it
 * back; every other reader is sent only that it works and the tools it ran (REQ-32 criterion 6).
 */
export function LiveTurn({
  progress,
  withdrawn,
  newestAgentId,
}: {
  progress: ConversationProgressEntry;
  withdrawn?: boolean;
  newestAgentId?: string;
}) {
  const t = useCopy();
  if (progress.view === "room") return <RoomLiveTurn progress={progress} />;
  const draft = !progress.verdict && carriesProse(progress.entry);
  return (
    <div className="flex flex-col gap-2" data-testid="thread-live-turn" data-live-view="asker">
      {withdrawn && <ReplacedDraftNote />}
      {draft && (
        <p className="fg-caption flex items-center gap-1.5 text-subtle" data-testid="thread-live-draft">
          <Icon name="alert" size={12} className="flex-none" />
          {t("conversations.live.draft")}
        </p>
      )}
      {progress.verdict === "withheld" && (
        <p className="fg-body-sm text-muted" data-testid="thread-live-withheld">
          {t("conversations.live.withheld")}
        </p>
      )}
      <AssistantTurn
        entry={progress.entry}
        streaming={!progress.replaced && !progress.verdict}
        {...(newestAgentId ? { newestAgentId } : {})}
      />
    </div>
  );
}

/** A turn somebody else asked: that it works, and the tools it ran by name and time — nothing it said. */
function RoomLiveTurn({ progress }: { progress: ConversationProgressEntry }) {
  const t = useCopy();
  const time = useTimeFormat();
  const tools = progress.tools ?? [];
  return (
    <div className="flex flex-col gap-1" data-testid="thread-live-turn" data-live-view="room">
      <p className="fg-body-sm text-muted">{t("conversations.live.working")}</p>
      {tools.length > 0 && (
        <ul className="flex flex-col divide-y divide-line-subtle border-y border-line-subtle">
          {tools.map((tool) => (
            <li key={tool.id} className="flex items-center gap-2 py-1" data-testid="thread-live-tool">
              <Icon
                name={tool.isError ? "alert" : "dot"}
                size={12}
                className={tool.isError ? "flex-none text-danger-11" : "flex-none text-subtle"}
              />
              <span className="flex-1 truncate font-mono text-12">{tool.name}</span>
              <span className="flex-none font-mono text-12 text-subtle">
                {!tool.done
                  ? t("conversations.live.toolRunning")
                  : typeof tool.durationMs === "number"
                    ? tool.durationMs >= 1000
                      ? t("conversations.live.toolSeconds", { n: time.number(Number((tool.durationMs / 1000).toFixed(1))) })
                      : t("conversations.live.toolMs", { n: tool.durationMs })
                    : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A runner-hosted turn, in whichever of its states it is in.
 */
export function AgentTurnEntry({ turn, projectSlug }: { turn: AgentTurn; projectSlug?: string | undefined }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const failed = turn.state === "failed";
  const held = turn.held?.reply ? turn.held : null;
  return (
    <div
      data-testid="thread-agent-turn"
      data-agent-turn-state={turn.state}
      className="rounded-md border border-line bg-surface px-3 py-2"
    >
      <p className="fg-body-sm text-muted">
        {t(AGENT_TURN_LABEL[turn.state as Exclude<AgentTurnState, "delivered">])}
      </p>
      {failed && turn.reason && <p className="fg-body-sm mt-1 text-fg">{turn.reason}</p>}
      {failed && (
        <p className="fg-caption mt-1 text-subtle" data-testid="thread-agent-turn-next">
          {turn.nextStep ?? t("conversations.agentTurn.askAgain")}
        </p>
      )}
      {held && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="fg-body-sm mt-1 underline underline-offset-2 hover:text-fg"
          data-testid="thread-held-reply-toggle"
        >
          {t(open ? "conversations.agentTurn.hideHeld" : "conversations.agentTurn.showHeld")}
        </button>
      )}
      {held && open && (
        <div className="mt-2 border-t border-line pt-2" data-testid="thread-held-reply">
          <p className="fg-caption text-subtle">{t("conversations.agentTurn.heldBy", { reason: held.reason })}</p>
          <p className="fg-body-sm mt-1 whitespace-pre-wrap text-fg">{held.reply}</p>
          {held.blocks && held.blocks.length > 0 && (
            // the blocks the session drew for this reply, held with it: nobody else in the room sees them
            <VisualBlockProvider value={{ projectSlug, sourceFacts: runFactsIn([{ blocks: held.blocks }]), executionFacts: executionFactsIn([{ blocks: held.blocks }]) }}>
              <div className="mt-2 flex flex-col gap-3" data-testid="thread-held-blocks">
                {keyedByContent(held.blocks).map(({ key, item: b }) => (
                  <VisualBlockView key={key} block={b.visual} />
                ))}
              </div>
            </VisualBlockProvider>
          )}
        </div>
      )}
    </div>
  );
}
