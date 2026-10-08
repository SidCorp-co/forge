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
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { isStructured, StructuredMessage } from "@/features/onboarding/components/thread-blocks";
import { Conversation } from "@/features/session/components/conversation";
import { DisclosureScope } from "@/features/session/disclosure";
import { USER_BUBBLE } from "@/features/session/layout";
import { settingsHref } from "@/features/project-settings/sections";
import { ShareAction, shareSubjectOf } from "@/features/shares";
import { runFactsIn, VisualBlockProvider, VisualBlockView } from "@/features/visual-blocks";
import { type MessageEntry, parseMessages } from "@/features/session/types";
import { type Correction, withoutCorrections } from "../corrections";
import {
  AGENT_TURN_LABEL,
  type AgentTurn,
  type AgentTurnState,
  type ConversationMessage,
  type ConversationWindow,
  type ConversationProgressEntry,
  type OutboxMessage,
  silenceDetailSentence,
  silenceSentence,
  threadEntries,
  turnFailureOf,
  undeliveredReplyOf,
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
  const t = useCopy();
  return (
    <div
      role="alert"
      data-testid="thread-correction"
      className="flex items-start gap-2 rounded-md border px-3 py-2"
      style={{ borderColor: "var(--red-500)", background: "var(--red-50)" }}
    >
      <Icon name="alert" size={15} className="mt-0.5 flex-none text-[color:var(--red-600)]" />
      <p className="fg-body-sm text-fg">
        <span className="font-semibold">{t("shell.thread.correction")}</span> {t("shell.thread.refused", { what: correction.what })} (
        <span className="font-mono">{correction.code}</span>){t("shell.thread.nothingWritten")}
      </p>
    </div>
  );
}

/**
 * A draft the reply screen refused, named and struck through, above the turn that replaced it.
 */
function WithdrawnDraft({ draft }: { draft: string }) {
  const t = useCopy();
  return (
    <div
      className="rounded-md border border-line bg-surface px-3 py-2"
      data-testid="thread-reply-withdrawn"
    >
      <p className="fg-body-sm flex items-start gap-2 text-muted">
        <Icon name="alert" size={13} className="mt-0.5 flex-none" />
        <span>
          {t("shell.thread.withdrawn")}
        </span>
      </p>
      <p className="fg-caption mt-1 whitespace-pre-wrap text-subtle line-through">{draft}</p>
    </div>
  );
}

/** The clock a reader needs beside a turn: when, in the interface language. */
function spokenAt(iso: string, time: ReturnType<typeof useTimeFormat>): { label: string; title: string } {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { label: "", title: iso };
  return { label: time.clock(at), title: time.dateTime(at) };
}

/**
 * Who said it, when, and a way to take the text away.
 *
 * Read-only affordances only: a conversation is an append-only log, so nothing
 * here rewrites a turn (ISS-1004's rule, which stands).
 */
function MessageActions({ message, share }: { message: ConversationMessage; share?: ShareScope | undefined }) {
  const [copied, setCopied] = useState(false);
  const t = useCopy();
  const when = spokenAt(message.createdAt, useTimeFormat());
  const author = message.authorLabel ?? (message.role === "user" ? t("common.nav.you") : t("shell.mode.assistant"));
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
        aria-label={t(when.label ? "shell.thread.copyAt" : "shell.thread.copyFrom", { verb: copied ? t("shell.thread.copied") : t("shell.thread.copy"), author, at: when.label })}
        className="rounded-sm underline-offset-2 hover:text-fg hover:underline"
      >
        {copied ? t("shell.thread.copied") : t("shell.thread.copy")}
      </button>
      {share && <ShareOf message={message} share={share} />}
    </div>
  );
}

/** The project an answer is shared from, and the slug that names where its links are listed. */
interface ShareScope {
  projectId: string;
  projectSlug: string | undefined;
}

/** Share, beside Copy, on an answer that holds a report block or a template's output; else nothing. */
function ShareOf({ message, share }: { message: ConversationMessage; share: ShareScope }) {
  const subject = shareSubjectOf(message);
  if (!subject) return null;
  return (
    <ShareAction
      projectId={share.projectId}
      subject={subject}
      manageHref={share.projectSlug ? settingsHref(share.projectSlug, "people", "shares") : undefined}
    />
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
  share,
}: {
  message: ConversationMessage;
  withdrawn?: string;
  newestAgentId?: string;
  firstDesigns?: boolean;
  share?: ShareScope | undefined;
}) {
  const t = useCopy();
  // a questionnaire, its answers and a designs list are structured messages a service wrote;
  // they draw from the thread's live data, never through the model-turn renderer
  if (isStructured(message.blocks)) {
    return <StructuredMessage message={message} firstDesigns={firstDesigns === true} />;
  }
  if (message.silenceReason) {
    return (
      <div className="flex items-start gap-2 text-muted">
        <Icon name="dot" size={13} className="mt-1 flex-none" />
        <p className="fg-body-sm italic" title={message.silenceReason} data-value={message.silenceReason} data-testid="thread-silence-row">
          {silenceSentence(message.silenceReason, t)}
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
      <MessageActions message={message} share={share} />
    </div>
  );
}

function Unsent({ item, onRetry }: { item: OutboxMessage; onRetry?: (id: string) => void }) {
  const failed = item.state === "failed";
  const t = useCopy();
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
          {t("shell.thread.sendFailed")} {item.error}
          {onRetry && (
            <button type="button" className="underline" onClick={() => onRetry(item.id)}>
              {t("shell.thread.tryAgain")}
            </button>
          )}
        </span>
      ) : (
        item.state !== "sent" && (
          <span className="fg-caption mt-1 text-subtle">
            {item.state === "sending" ? t("shell.thread.sending") : t("shell.thread.queued")}
          </span>
        )
      )}
    </div>
  );
}

export function ConversationThread({
  projectId,
  projectSlug,
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
  /** The project the room is about, so an answer holding a report can be shared from it. */
  projectId?: string | undefined;
  /** The project's slug, for the links a report block's refs open; plain text until it is known. */
  projectSlug?: string | undefined;
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
  const t = useCopy();
  const language = useInterfaceLanguage();
  const entries = threadEntries(messages, windows, outbox, agentTurns, progress);
  const firstDesignsId = messages.find((m) => m.blocks?.some((b) => b.type === "designs"))?.id;
  const newestAgentId = entries.reduce<string | undefined>((id, entry) => {
    if (entry.kind === "progress") return entry.progress.entry.id ?? id;
    if (entry.kind === "said" && entry.message.role === "assistant") return entry.message.id;
    return id;
  }, undefined);
  return (
    <DisclosureScope {...(atBottom !== undefined ? { atBottom } : {})}>
    <VisualBlockProvider value={{ projectSlug, sourceFacts: runFactsIn(messages) }}>
    <div className="flex flex-col gap-5">
      {entries.map((entry) => {
        if (entry.kind === "said")
          return (
            // a questionnaire collapsed into its answers draws nothing, and an empty entry must not leave a gap
            <div key={entry.key} className="empty:hidden">
              <Said
                message={entry.message}
                {...(withdrawn[entry.message.id] ? { withdrawn: withdrawn[entry.message.id] } : {})}
                {...(newestAgentId ? { newestAgentId } : {})}
                firstDesigns={entry.message.id === firstDesignsId}
                share={projectId ? { projectId, projectSlug } : undefined}
              />
              {afterEntry?.(entry.message.id)}
            </div>
          );
        if (entry.kind === "outbox")
          return <Unsent key={entry.key} item={entry.item} onRetry={onRetry} />;
        if (entry.kind === "pending") {
          return (
            <p key={entry.key} className="fg-caption text-subtle" data-testid="thread-pending">
              {t("conversations.thread.pending")}
            </p>
          );
        }
        if (entry.kind === "agent-turn")
          return <AgentTurnEntry key={entry.key} turn={entry.turn} projectSlug={projectSlug} />;
        if (entry.kind === "handed") {
          return (
            <p key={entry.key} className="fg-caption text-subtle" data-testid="thread-handed-to-job">
              {t("conversations.thread.handed", { reason: entry.reason })}
            </p>
          );
        }
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
        const undelivered = undeliveredReplyOf(entry.detail, t);
        const failure = turnFailureOf(entry.detail);
        return (
          <div
            key={entry.key}
            data-testid="thread-silence"
            className="rounded-md border border-line bg-surface px-3 py-2"
          >
            <p className="fg-body-sm text-muted" title={failure ? failure.code : t("conversations.silence.decisionTitle", { code: entry.decision })} data-value={failure ? failure.code : entry.decision}>
              {undelivered
                ? t("conversations.thread.undelivered", { reason: undelivered.reason })
                : failure
                  ? `${failure.reason} (${failure.code})`
                  : silenceDetailSentence(entry.decision, entry.detail, language)}
            </p>
            {undelivered && (
              <p className="fg-body-sm mt-1 whitespace-pre-wrap" data-testid="thread-undelivered-reply">
                {undelivered.reply}
              </p>
            )}
          </div>
        );
      })}
    </div>
    </VisualBlockProvider>
    </DisclosureScope>
  );
}

/** Whether an entry carries prose — in the asker's view before the verdict, a draft. */
function carriesProse(entry: MessageEntry): boolean {
  return (entry.blocks ?? []).some((b) => b.type === "text" && !!b.text) || (typeof entry.content === "string" && entry.content.trim() !== "");
}

/**
 * The turn running right now, in the view core sent this reader. The person it answers sees the
 * draft as it streams, labelled unchecked until the verdict replaces it with the reply or takes it
 * back; every other reader is sent only that it works and the tools it ran (REQ-32 criterion 6).
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
  const t = useCopy();
  if (progress.view === "room") return <RoomLiveTurn progress={progress} />;
  const draft = !progress.verdict && carriesProse(progress.entry);
  return (
    <div className="flex flex-col gap-2" data-testid="thread-live-turn" data-live-view="asker">
      {withdrawn && <WithdrawnDraft draft={withdrawn} />}
      {draft && (
        <p className="fg-caption flex items-center gap-1.5 text-subtle" data-testid="thread-live-draft" title={t("conversations.live.draftWhy")}>
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
                className="flex-none"
                style={{ color: tool.isError ? "var(--red-600)" : "var(--fg-subtle)" }}
              />
              <span className="flex-1 truncate font-mono" style={{ fontSize: "var(--text-12)" }}>{tool.name}</span>
              <span className="flex-none font-mono text-subtle" style={{ fontSize: "var(--text-11)" }}>
                {!tool.done
                  ? t("conversations.live.toolRunning")
                  : typeof tool.durationMs === "number"
                    ? tool.durationMs >= 1000
                      ? `${time.number(Number((tool.durationMs / 1000).toFixed(1)))}s`
                      : `${tool.durationMs}ms`
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
function AgentTurnEntry({ turn, projectSlug }: { turn: AgentTurn; projectSlug?: string | undefined }) {
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
        <p className="fg-caption mt-1 text-subtle">
          {t("conversations.agentTurn.askAgain")}
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
            <VisualBlockProvider value={{ projectSlug, sourceFacts: runFactsIn([{ blocks: held.blocks }]) }}>
              <div className="mt-2 flex flex-col gap-3" data-testid="thread-held-blocks">
                {held.blocks.map((b, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the held reply's block order is fixed
                  <VisualBlockView key={i} block={b.visual} />
                ))}
              </div>
            </VisualBlockProvider>
          )}
        </div>
      )}
    </div>
  );
}
