"use client";

// The durable conversation, rendered: what was said, and — where nothing was —
// the decision that says why.
//
// This is the half of ISS-1004 a person can see. The store has recorded a
// reason for every silence since the collector window landed, and until this
// file existed the only reader was a SQL prompt.

import { Icon, StreamingText } from "@/design";
import {
  AGENT_TURN_LABEL,
  SILENCE_REASON,
  type AgentTurn,
  type AgentTurnState,
  type ConversationMessage,
  type ConversationWindow,
  type OutboxMessage,
  threadEntries,
} from "../types";

function Said({ message }: { message: ConversationMessage }) {
  // cm:guard a row carrying a `silence_reason` is a turn that RAN and said nothing, and it renders as that rather than as an empty bubble — an assistant message with no text and no label is indistinguishable on screen from one still streaming.
  if (message.silenceReason) {
    return (
      <div className="flex items-start gap-2 text-muted">
        <Icon name="dot" size={13} className="mt-1 flex-none" />
        <p className="fg-body-sm italic">
          The agent said nothing here — {message.silenceReason}
        </p>
      </div>
    );
  }
  // cm:guard a `system` row is ONE muted line and never a bubble: it is the room telling its readers what happened to it — who joined, why it is a group now — and rendered as an assistant turn it would read as the agent claiming somebody joined (ISS-1034 criterion 48).
  if (message.role === "system") {
    return (
      <p
        className="fg-caption text-center text-subtle"
        data-testid="thread-system"
      >
        {message.content}
      </p>
    );
  }
  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end">
        <div className="max-w-[88%] rounded-lg rounded-br-sm bg-accent px-3.5 py-2.5 text-on-accent sm:max-w-[80%]">
          <p className="fg-body whitespace-pre-wrap text-on-accent">{message.content}</p>
        </div>
        {message.authorLabel && (
          <span className="fg-caption mt-1 text-subtle">{message.authorLabel}</span>
        )}
      </div>
    );
  }
  return (
    <div className="flex w-full max-w-[92%] flex-col gap-2 sm:max-w-[85%]">
      <StreamingText text={message.content} />
    </div>
  );
}

// cm:guard an unsent message renders through THIS component and the same bubble a said one gets,
// rather than a list of its own beside the thread: two renderers for "what I typed" is how the
// queued copy and the stored copy start disagreeing about spacing, order and who said it (ISS-1031).
function Unsent({ item, onRetry }: { item: OutboxMessage; onRetry?: (id: string) => void }) {
  const failed = item.state === "failed";
  return (
    <div className="flex flex-col items-end" data-testid={`thread-outbox-${item.state}`}>
      <div
        className={`max-w-[88%] rounded-lg rounded-br-sm px-3.5 py-2.5 sm:max-w-[80%] ${
          failed ? "border border-danger bg-surface" : "bg-accent/60 text-on-accent"
        }`}
      >
        <p className={`fg-body whitespace-pre-wrap ${failed ? "text-fg" : "text-on-accent"}`}>
          {item.content}
        </p>
      </div>
      {failed ? (
        <span className="fg-caption mt-1 flex items-center gap-2 text-danger">
          <Icon name="alert" size={12} className="flex-none" />
          Couldn&apos;t send. {item.error}
          {onRetry && (
            <button type="button" className="underline" onClick={() => onRetry(item.id)}>
              Try again
            </button>
          )}
        </span>
      ) : (
        <span className="fg-caption mt-1 text-subtle">
          {item.state === "sending" ? "Sending…" : "Waiting for the answer above…"}
        </span>
      )}
    </div>
  );
}

export function ConversationThread({
  messages,
  windows,
  outbox = [],
  agentTurns = [],
  onRetry,
}: {
  messages: ConversationMessage[];
  windows: ConversationWindow[];
  /** What this browser has accepted and the server has not confirmed (ISS-1031). */
  outbox?: OutboxMessage[];
  /** The runner-hosted turns this room has held, as the server reads their state (ISS-1039). */
  agentTurns?: AgentTurn[];
  onRetry?: (id: string) => void;
}) {
  const entries = threadEntries(messages, windows, outbox, agentTurns);
  return (
    <div className="flex flex-col gap-5">
      {entries.map((entry) => {
        if (entry.kind === "said") return <Said key={entry.key} message={entry.message} />;
        if (entry.kind === "outbox")
          return <Unsent key={entry.key} item={entry.item} onRetry={onRetry} />;
        if (entry.kind === "pending") {
          return (
            <p key={entry.key} className="fg-caption text-subtle" data-testid="thread-pending">
              Nobody has answered this yet.
            </p>
          );
        }
        if (entry.kind === "agent-turn") return <AgentTurnEntry key={entry.key} turn={entry.turn} />;
        return (
          <div
            key={entry.key}
            data-testid="thread-silence"
            className="rounded-md border border-line bg-surface px-3 py-2"
          >
            <p className="fg-body-sm text-muted">{SILENCE_REASON[entry.decision]}</p>
            <p className="fg-caption mt-0.5 font-mono text-subtle">{entry.decision}</p>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A runner-hosted turn, in whichever of its states it is in.
 */
// cm:guard the three states are told apart by what the person can DO about each, not by a colour:
// `dispatched` and `running` are waits with nothing owed of them, and `failed` owes a sentence
// saying which failure it was and a sentence saying what to do next. A single grey line for all
// three is the blank thread ISS-1039 exists to remove.
// cm:guard `delivered` never reaches here — `threadEntries` drops it, because its reply is a message
// row below it and a label would print the same answer twice.
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
      {!failed && (
        <p className="fg-caption mt-0.5 font-mono text-subtle">agent · {turn.state}</p>
      )}
    </div>
  );
}
