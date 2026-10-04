"use client";

// The durable conversation, rendered: what was said, and — where nothing was —
// the decision that says why.
//
// This is the half of ISS-1004 a person can see. The store has recorded a
// reason for every silence since the collector window landed, and until this
// file existed the only reader was a SQL prompt.
//
// Since ISS-1078 an assistant turn is drawn by `features/session`'s own
// renderer, off the same canonical entry a runner session is drawn from, and a
// turn still running is drawn from the frames the socket carries. What is NOT
// drawn by it: a person's own bubble, which carries an `authorLabel` a session
// has no notion of, and the four non-message entries below.

import { DisclosureScope } from "@/features/session/disclosure";
import {
  AGENT_TURN_LABEL,
  SILENCE_REASON,
  type AgentTurn,
  type AgentTurnState,
  type ConversationMessage,
  type ConversationWindow,
  type ConversationProgressEntry,
  type OutboxMessage,
  threadEntries,
} from "../types";
import { AssistantTurn, Said, Unsent, WithdrawnDraft } from "./thread-said";

export function ConversationThread({
  messages,
  windows,
  outbox = [],
  agentTurns = [],
  progress,
  withdrawn = {},
  atBottom,
  onRetry,
  afterEntry,
}: {
  messages: ConversationMessage[];
  windows: ConversationWindow[];
  /** What this browser has accepted and the server has not confirmed (ISS-1031). */
  outbox?: OutboxMessage[];
  /** The runner-hosted turns this room has held, as the server reads their state (ISS-1039). */
  agentTurns?: AgentTurn[];
  /** The turn running right now, as the socket's frames have it so far (ISS-1078). */
  progress?: ConversationProgressEntry | null;
  /** Drafts the reply screen refused in this room, by the entry id that replaced each (ISS-1078). */
  withdrawn?: Record<string, string>;
  /**
   * Whether the reader is at the bottom of this thread (ISS-1083).
   */
  atBottom?: boolean;
  onRetry?: (id: string) => void;
  /** What follows a turn in the thread — the UI actions it took, as cards (ISS-47). */
  afterEntry?: (entryId: string) => React.ReactNode;
}) {
  const entries = threadEntries(messages, windows, outbox, agentTurns, progress);
  const firstDesignsId = messages.find((m) => m.blocks?.some((b) => b.type === "designs"))?.id;
  const newestAgentId = entries.reduce<string | undefined>((id, entry) => {
    if (entry.kind === "progress") return entry.progress.entry.id ?? id;
    if (entry.kind === "said" && entry.message.role === "assistant") return entry.message.id;
    return id;
  }, undefined);
  return (
    <DisclosureScope {...(atBottom !== undefined ? { atBottom } : {})}>
    <div className="flex flex-col gap-5">
      {entries.map((entry) => (
        <ThreadEntry
          key={entry.key}
          entry={entry}
          withdrawn={withdrawn}
          newestAgentId={newestAgentId}
          firstDesignsId={firstDesignsId}
          onRetry={onRetry}
          afterEntry={afterEntry}
        />
      ))}
    </div>
    </DisclosureScope>
  );
}

function ThreadEntry({
  entry,
  withdrawn,
  newestAgentId,
  firstDesignsId,
  onRetry,
  afterEntry,
}: {
  entry: ReturnType<typeof threadEntries>[number];
  withdrawn: Record<string, string>;
  newestAgentId: string | undefined;
  firstDesignsId: string | undefined;
  onRetry: ((id: string) => void) | undefined;
  afterEntry: ((entryId: string) => React.ReactNode) | undefined;
}) {
  if (entry.kind === "said")
    return (
      // cm:why a questionnaire collapsed into its answers draws nothing, and an empty entry must not leave a gap
      <div className="empty:hidden">
        <Said
          message={entry.message}
          withdrawn={withdrawn[entry.message.id]}
          newestAgentId={newestAgentId}
          firstDesigns={entry.message.id === firstDesignsId}
        />
        {afterEntry?.(entry.message.id)}
      </div>
    );
  if (entry.kind === "outbox") return <Unsent item={entry.item} onRetry={onRetry} />;
  if (entry.kind === "pending")
    return (
      <p className="fg-caption text-subtle" data-testid="thread-pending">
        Nobody has answered this yet.
      </p>
    );
  if (entry.kind === "agent-turn") return <AgentTurnEntry turn={entry.turn} />;
  if (entry.kind === "progress")
    return (
      <div>
        <LiveTurn
          progress={entry.progress}
          withdrawn={withdrawn[entry.progress.entry.id ?? ""]}
          newestAgentId={newestAgentId}
        />
        {afterEntry?.(entry.progress.entry.id ?? "live")}
      </div>
    );
  return (
    <div data-testid="thread-silence" className="rounded-md border border-line bg-surface px-3 py-2">
      <p className="fg-body-sm text-muted" title={`decision: ${entry.decision}`}>
        {SILENCE_REASON[entry.decision]}
      </p>
    </div>
  );
}

/**
 * The turn running right now, and — where the door replaced its draft — that fact.
 */
function LiveTurn({
  progress,
  withdrawn,
  newestAgentId,
}: {
  progress: ConversationProgressEntry;
  withdrawn: string | undefined;
  newestAgentId: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="thread-live-turn">
      {withdrawn && <WithdrawnDraft draft={withdrawn} />}
      <AssistantTurn entry={progress.entry} streaming={!progress.replaced} newestAgentId={newestAgentId} />
    </div>
  );
}

/**
 * A runner-hosted turn, in whichever of its states it is in.
 */
function AgentTurnEntry({ turn }: { turn: AgentTurn }) {
  const failed = turn.state === "failed";
  return (
    <div
      data-testid="thread-agent-turn"
      data-agent-turn-state={turn.state}
      className="rounded-md border border-line bg-surface px-3 py-2"
    >
      <p className="fg-body-sm text-muted">
        {AGENT_TURN_LABEL[turn.state as Exclude<AgentTurnState, "delivered">]}
      </p>
      {failed && turn.reason && <p className="fg-body-sm mt-1 text-fg">{turn.reason}</p>}
      {failed && (
        <p className="fg-caption mt-1 text-subtle">
          Ask again to start a fresh session, or open a conversation in Assistant mode if the
          question does not need the repository.
        </p>
      )}
    </div>
  );
}
