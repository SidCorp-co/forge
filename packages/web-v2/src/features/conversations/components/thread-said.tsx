"use client";

// What one stored message, or one this browser has not had confirmed, looks like in the thread.

import { useState } from "react";
import { Icon } from "@/design";
import { isStructured, StructuredMessage } from "@/features/onboarding/components/thread-blocks";
import { Conversation } from "@/features/session/components/conversation";
import { USER_BUBBLE } from "@/features/session/layout";
import { type MessageEntry, parseMessages } from "@/features/session/types";
import { type Correction, withoutCorrections } from "../corrections";
import type { ConversationMessage, OutboxMessage } from "../types";

/** One stored row as the canonical entry every renderer here reads. */
function entryOf(message: ConversationMessage): MessageEntry {
  return {
    id: message.id,
    type: message.role === "user" ? "user" : "assistant",
    timestamp: Date.parse(message.createdAt),
    content: message.content,
    ...(message.blocks ? { blocks: message.blocks } : {}),
  };
}

export function AssistantTurn({
  entry,
  streaming,
  newestAgentId,
}: {
  entry: MessageEntry;
  streaming?: boolean;
  /** The thread's newest assistant turn — every turn above it folds its machinery (ISS-1083). */
  newestAgentId?: string | undefined;
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
export function WithdrawnDraft({ draft }: { draft: string }) {
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

export function Said({
  message,
  withdrawn,
  newestAgentId,
  firstDesigns,
}: {
  message: ConversationMessage;
  withdrawn?: string | undefined;
  newestAgentId?: string | undefined;
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
      <AssistantTurn entry={entryOf(message)} newestAgentId={newestAgentId} />
      <MessageActions message={message} />
    </div>
  );
}

export function Unsent({ item, onRetry }: { item: OutboxMessage; onRetry?: (id: string) => void }) {
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
