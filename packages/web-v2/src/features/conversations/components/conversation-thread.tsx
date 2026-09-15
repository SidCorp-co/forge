"use client";

// The durable conversation, rendered: what was said, and — where nothing was —
// the decision that says why.
//
// This is the half of ISS-1004 a person can see. The store has recorded a
// reason for every silence since the collector window landed, and until this
// file existed the only reader was a SQL prompt.

import { Icon, StreamingText } from "@/design";
import {
  SILENCE_REASON,
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
  onRetry,
}: {
  messages: ConversationMessage[];
  windows: ConversationWindow[];
  /** What this browser has accepted and the server has not confirmed (ISS-1031). */
  outbox?: OutboxMessage[];
  onRetry?: (id: string) => void;
}) {
  const entries = threadEntries(messages, windows, outbox);
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
