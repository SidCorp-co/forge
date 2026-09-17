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

import { Icon } from "@/design";
import { Conversation } from "@/features/session/components/conversation";
import { DisclosureScope } from "@/features/session/disclosure";
import { USER_BUBBLE } from "@/features/session/layout";
import { type MessageEntry, parseMessages } from "@/features/session/types";
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
// cm:guard `blocks` is passed through UNTOUCHED and is never rebuilt from `content`: the row's blocks
// are what core accumulated for the text in `content`, and a browser that composed its own would be
// the second producer of the shape ISS-1029 collapsed to one.
function entryOf(message: ConversationMessage): MessageEntry {
  return {
    id: message.id,
    type: message.role === "user" ? "user" : "assistant",
    timestamp: Date.parse(message.createdAt),
    content: message.content,
    ...(message.blocks ? { blocks: message.blocks } : {}),
  };
}

/**
 * An assistant turn, drawn by the renderer a runner session is drawn by.
 */
// cm:guard it goes through `parseMessages` and `Conversation` rather than printing `content`, which is
// what discarded every tool card this room's rows have held since ISS-1029: the blocks were in the
// payload, the type dropped them, and the thread printed one paragraph. `readOnly` because a
// conversation is an append-only log and has none of the per-turn verbs a run has — the reason
// `conversation-chat.tsx` gives for leaving all six on the session surface.
// cm:guard NOTHING renders where the entry carries nothing — no text, no blocks, no tools. Such a row
// is a turn that said nothing without recording why, and `parseMessages` drops it; a placeholder here
// would invent a turn the transcript does not claim.
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
  const items = parseMessages([entry]);
  if (items.length === 0) return null;
  // cm:guard NO width cap here. `Conversation`'s own `AgentTurn` owns the assistant column's
  // measure, and this wrapper used to carry the identical literal — nested, the two multiplied to
  // 0.85 x 0.85 = 0.7225, so a turn got 72% of the panel and a ~160px blank column beside it at a
  // 550px width. The cap lives in the SHARED renderer rather than here because the full-page
  // session screen draws through the same component and would otherwise have no policy at all
  // (ISS-1083, plan consult decision 1).
  // cm:guard `newestAgentId` is passed from the THREAD and never left to `Conversation`: this
  // component mounts one renderer per turn, so an instance's own last item is always its only item
  // and nothing here would ever fold without it (ISS-1083 criterion 22).
  return (
    <Conversation
      items={items}
      readOnly
      streaming={streaming}
      {...(newestAgentId ? { newestAgentId } : {})}
    />
  );
}

/**
 * A draft the reply screen refused, named and struck through, above the turn that replaced it.
 */
// cm:guard the withdrawal is DRAWN and the draft is named in it. The door screen judges a whole reply
// after the turn ends, so the prose that streamed was never screened, and a refusal replaces it —
// this marker is the whole of what makes that replacement a correction a reader can see rather than a
// substitution that happened while they were looking. The reversal, its price and the condition that
// ends it are on the `web-chat-reply` row in core's `messaging/doors.ts`. Owner's decision, 2026-09-17.
// cm:guard rendered from the socket-written `withdrawn` map and keyed by ENTRY ID, so it survives the
// settle and stays beside the stored row as well as beside the live turn: drawn off the progress
// entry alone it lasted 13 ms, because `conversation.settled` clears that key within a few
// milliseconds of the correction frame (measured in Chrome, 2026-09-17).
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

function Said({
  message,
  withdrawn,
  newestAgentId,
}: {
  message: ConversationMessage;
  withdrawn?: string;
  newestAgentId?: string;
}) {
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
        <div className={`${USER_BUBBLE} rounded-lg rounded-br-sm bg-accent px-3.5 py-2.5 text-on-accent`}>
          <p className="fg-body whitespace-pre-wrap text-on-accent">{message.content}</p>
        </div>
        {message.authorLabel && (
          <span className="fg-caption mt-1 text-subtle">{message.authorLabel}</span>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {withdrawn && <WithdrawnDraft draft={withdrawn} />}
      <AssistantTurn entry={entryOf(message)} {...(newestAgentId ? { newestAgentId } : {})} />
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
        // cm:guard a `sent` bubble is drawn at FULL strength, the same as a stored one: the faded
        // accent says "not filed yet", and once the accepted frame has arrived that is no longer true.
        // A row that stays faded until a refetch tells a person their message is still in flight for as
        // long as the turn takes, which is the defect this state exists to end.
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
        // cm:guard `sent` carries NO label at all, which is the whole of what ISS-1078 asked for here:
        // the message is a durable row, so there is nothing left to say about it and a person watching
        // their own question should see it sitting there like any other. The row itself stays until the
        // room's read catches up — without a word under it (ISS-1078).
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
  // cm:guard it reaches the turns through the scope rather than as a prop on each of them, because
  // it is the same kind of fact as which disclosures they have opened — what this thread knows about
  // its reader — and exactly one thing consults it: a turn deciding whether it may fold.
  atBottom?: boolean;
  onRetry?: (id: string) => void;
}) {
  const entries = threadEntries(messages, windows, outbox, agentTurns, progress);
  // The thread's newest assistant turn, which is the one that never folds (ISS-1083 criterion 21).
  // cm:guard read off the ENTRIES and not off `messages`, because the turn in flight is not a
  // message yet: `threadEntries` is the one authority on what this thread's order is, including
  // whether the frames still count as a turn of their own, and asking `messages` for the newest
  // would fold the answer a person is watching arrive the moment it landed.
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
            <Said
              key={entry.key}
              message={entry.message}
              {...(withdrawn[entry.message.id] ? { withdrawn: withdrawn[entry.message.id] } : {})}
              {...(newestAgentId ? { newestAgentId } : {})}
            />
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
            <LiveTurn
              key={entry.key}
              progress={entry.progress}
              {...(withdrawn[entry.progress.entry.id ?? ""]
                ? { withdrawn: withdrawn[entry.progress.entry.id ?? ""] }
                : {})}
              {...(newestAgentId ? { newestAgentId } : {})}
            />
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
// cm:guard the caret is driven by `streaming` on the SAME component a live runner session uses, so a
// turn in flight here and a turn in flight there are one behaviour rather than two that resemble each
// other (ISS-1078 criterion 13).
// cm:guard the withdrawal is DRAWN and the draft is named in it. The door screen judges a whole reply
// after the turn ends, so the prose that streamed was never screened, and a refusal replaces it — this
// marker is the whole of what makes that replacement a correction a reader can see rather than a
// substitution that happened while they were looking. The reversal, its price and the condition that
// ends it are on the `web-chat-reply` row in core's `messaging/doors.ts`. Owner's decision, 2026-09-17.
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
      {/* cm:guard the caret stops on the CORRECTION frame, which is the last one of the turn: a caret
          still trailing it would say the replacement is being typed when it is already whole. */}
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
