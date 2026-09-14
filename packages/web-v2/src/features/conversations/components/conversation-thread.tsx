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

export function ConversationThread({
  messages,
  windows,
}: {
  messages: ConversationMessage[];
  windows: ConversationWindow[];
}) {
  const entries = threadEntries(messages, windows);
  return (
    <div className="flex flex-col gap-5">
      {entries.map((entry) => {
        if (entry.kind === "said") return <Said key={entry.key} message={entry.message} />;
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
