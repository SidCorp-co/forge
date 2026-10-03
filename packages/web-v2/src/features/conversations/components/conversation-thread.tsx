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

import { useState } from "react";
import { Icon } from "@/design";
import { isStructured, StructuredMessage } from "@/features/onboarding/components/thread-blocks";
import { Conversation } from "@/features/session/components/conversation";
import { DisclosureScope } from "@/features/session/disclosure";
import { USER_BUBBLE } from "@/features/session/layout";
import { type MessageEntry, parseMessages } from "@/features/session/types";
import { type Correction, withoutCorrections } from "../corrections";
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

/**
 * One stored row as the canonical entry every renderer here reads.
 */
function entryOf(message: ConversationMessage): MessageEntry {
  return {
    id: message.id,
    type: message.role === "user" ? "user" : "assistant",
    timestamp: Date.parse(message.createdAt),
    content: message.content,
    ...(message.blocks ? { blocks: message.blocks } : {}),
  };
}

function AssistantTurn({
  entry,
  streaming,
  newestAgentId,
}: {
  entry: MessageEntry;
  streaming?: boolean;
  /** The thread's newest assistant turn — every turn above it folds its machinery (ISS-1083). */
  newestAgentId?: string;
}) {
  const { entry: prose, corrections } = withoutCorrections(entry);
  const items = parseMessages([prose]);
  if (items.length === 0 && corrections.length === 0) return null;
  return (
    <>
      {items.length > 0 && (
        <Conversation
          items={items}
          readOnly
          streaming={streaming}
          {...(newestAgentId ? { newestAgentId } : {})}
        />
      )}
      {corrections.map((c) => (
        <CorrectionLine key={c.line} correction={c} />
      ))}
    </>
  );
}

function CorrectionLine({ correction }: { correction: Correction }) {
  return (
    <div
      role="alert"
      data-testid="thread-correction"
      className="flex items-start gap-2 rounded-md border px-3 py-2"
      style={{ borderColor: "var(--red-500)", background: "var(--red-50)" }}
    >
      <Icon name="alert" size={15} className="mt-0.5 flex-none text-[color:var(--red-600)]" />
      <p className="fg-body-sm text-fg">
        <span className="font-semibold">Correction:</span> {correction.what} was refused (
        <span className="font-mono">{correction.code}</span>); nothing was written.
      </p>
    </div>
  );
}

/**
 * A draft the reply screen refused, named and struck through, above the turn that replaced it.
 */
function WithdrawnDraft({ draft }: { draft: string }) {
  return (
    <div
      className="rounded-md border border-line bg-surface px-3 py-2"
      data-testid="thread-reply-withdrawn"
    >
      <p className="fg-body-sm flex items-start gap-2 text-muted">
        <Icon name="alert" size={13} className="mt-0.5 flex-none" />
        <span>
          That draft did not pass the reply check, so it was withdrawn and answered again below.
        </span>
      </p>
      <p className="fg-caption mt-1 whitespace-pre-wrap text-subtle line-through">{draft}</p>
    </div>
  );
}

/** The clock a reader needs beside a turn: when, in their own locale. */
function spokenAt(iso: string): { label: string; title: string } {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { label: "", title: iso };
  return {
    label: at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    title: at.toLocaleString(),
  };
}

/**
 * Who said it, when, and a way to take the text away.
 *
 * Read-only affordances only: a conversation is an append-only log, so nothing
 * here rewrites a turn (ISS-1004's rule, which stands).
 */
function MessageActions({ message }: { message: ConversationMessage }) {
  const [copied, setCopied] = useState(false);
  const when = spokenAt(message.createdAt);
  const author = message.authorLabel ?? (message.role === "user" ? "You" : "Assistant");
  const copy = () => {
    navigator.clipboard?.writeText(message.content).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  };
  return (
    <div
      className="fg-caption flex items-center gap-2 text-subtle"
      data-testid="message-actions"
    >
      <span>{author}</span>
      <span aria-hidden="true">·</span>
      <time dateTime={message.createdAt} title={when.title}>
        {when.label}
      </time>
      <button
        type="button"
        onClick={copy}
        // A list of controls all named "Copy" does not say which is which; the
        // name leads with the visible word so a voice command still finds it.
        aria-label={`${copied ? "Copied" : "Copy"} message from ${author}${when.label ? ` at ${when.label}` : ""}`}
        className="rounded-sm underline-offset-2 hover:text-fg hover:underline"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * The files a person sent with a turn, as the thread shows them — stored, or
 * still on their way with a message this browser has not had confirmed.
 */
function SentFiles({ files }: { files: readonly { key: string; name: string }[] }) {
  return (
    <ul className="mt-1 flex flex-wrap justify-end gap-1.5" data-testid="message-files">
      {files.map((file) => (
        <li
          key={file.key}
          className="flex max-w-60 items-center gap-1.5 rounded-md border border-line-subtle bg-surface px-2 py-1"
        >
          <Icon name="grid" size={13} className="flex-none text-subtle" />
          <span className="fg-caption truncate text-fg">{file.name}</span>
        </li>
      ))}
    </ul>
  );
}

function Said({
  message,
  withdrawn,
  newestAgentId,
  firstDesigns,
}: {
  message: ConversationMessage;
  withdrawn?: string;
  newestAgentId?: string;
  firstDesigns?: boolean;
}) {
  // cm:why a questionnaire, its answers and a designs list are structured messages a service wrote;
  // they draw from the thread's live data, never through the model-turn renderer
  if (isStructured(message.blocks)) {
    return <StructuredMessage message={message} firstDesigns={firstDesigns === true} />;
  }
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
        {message.content && (
          <div className={`${USER_BUBBLE} rounded-lg rounded-br-sm bg-accent px-3.5 py-2.5 text-on-accent`}>
            <p className="fg-body whitespace-pre-wrap text-on-accent">{message.content}</p>
          </div>
        )}
        {message.images && message.images.length > 0 && (
          <SentFiles files={message.images.map((image) => ({ key: image.ref, name: image.name }))} />
        )}
        <div className="mt-1">
          <MessageActions message={message} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {withdrawn && <WithdrawnDraft draft={withdrawn} />}
      <AssistantTurn entry={entryOf(message)} {...(newestAgentId ? { newestAgentId } : {})} />
      <MessageActions message={message} />
    </div>
  );
}

function Unsent({ item, onRetry }: { item: OutboxMessage; onRetry?: (id: string) => void }) {
  const failed = item.state === "failed";
  return (
    <div className="flex flex-col items-end" data-testid={`thread-outbox-${item.state}`}>
      {item.content && (
        <div
          className={`${USER_BUBBLE} rounded-lg rounded-br-sm px-3.5 py-2.5 ${
            failed
              ? "border border-danger bg-surface"
              : item.state === "sent"
                ? "bg-accent text-on-accent"
                : "bg-accent/60 text-on-accent"
          }`}
        >
          <p className={`fg-body whitespace-pre-wrap ${failed ? "text-fg" : "text-on-accent"}`}>
            {item.content}
          </p>
        </div>
      )}
      {item.files && item.files.length > 0 && (
        <SentFiles files={item.files.map((file, index) => ({ key: `${index}-${file.name}`, name: file.name }))} />
      )}
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
        item.state !== "sent" && (
          <span className="fg-caption mt-1 text-subtle">
            {item.state === "sending" ? "Sending…" : "Waiting for the answer above…"}
          </span>
        )
      )}
    </div>
  );
}

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
      {entries.map((entry) => {
        if (entry.kind === "said")
          return (
            <div key={entry.key}>
              <Said
                message={entry.message}
                {...(withdrawn[entry.message.id] ? { withdrawn: withdrawn[entry.message.id] } : {})}
                {...(newestAgentId ? { newestAgentId } : {})}
                firstDesigns={entry.message.id === firstDesignsId}
              />
              {afterEntry?.(entry.message.id)}
            </div>
          );
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
        if (entry.kind === "progress")
          return (
            <div key={entry.key}>
            <LiveTurn
              progress={entry.progress}
              {...(withdrawn[entry.progress.entry.id ?? ""]
                ? { withdrawn: withdrawn[entry.progress.entry.id ?? ""] }
                : {})}
              {...(newestAgentId ? { newestAgentId } : {})}
            />
            {afterEntry?.(entry.progress.entry.id ?? "live")}
            </div>
          );
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
    </DisclosureScope>
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
  withdrawn?: string;
  newestAgentId?: string;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="thread-live-turn">
      {withdrawn && <WithdrawnDraft draft={withdrawn} />}
      <AssistantTurn
        entry={progress.entry}
        streaming={!progress.replaced}
        {...(newestAgentId ? { newestAgentId } : {})}
      />
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
      {!failed && (
        <p className="fg-caption mt-0.5 font-mono text-subtle">agent · {turn.state}</p>
      )}
    </div>
  );
}
