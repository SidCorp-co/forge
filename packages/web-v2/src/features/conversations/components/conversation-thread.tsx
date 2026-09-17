"use client";

// The durable conversation, rendered: what was said, and — where nothing was —
// the decision that says why.
//
// This is the half of ISS-1004 a person can see. The store has recorded a
// reason for every silence since the collector window landed, and until this
// file existed the only reader was a SQL prompt.

import { Icon } from "@/design";
import { Conversation } from "@/features/session/components/conversation";
import { parseMessages } from "@/features/session/types";
import {
  AGENT_TURN_LABEL,
  SILENCE_REASON,
  type AgentTurn,
  type AgentTurnState,
  type ConversationMessage,
  type ConversationProgress,
  type ConversationWindow,
  type OutboxMessage,
  threadEntries,
} from "../types";

/**
 * One assistant turn, drawn by the renderer a runner session is drawn by.
 */
// cm:guard the chat thread and the run thread render through ONE component off ONE derivation —
// `parseMessages` and `features/session/components/conversation.tsx` — because a conversation row's
// canonical entry and a runner turn's are the same shape and have been since ISS-1029. A second
// formatter under `features/conversations/` is exactly the drift that issue exists to prevent, and
// the content-only `StreamingText` path this replaces is why a room that ran six tools drew one
// paragraph (ISS-1078 criteria 13 and 19).
// cm:guard `readOnly`, and not as decoration: fork, rerun, per-turn edit and regenerate all rewrite
// a RUN's turns, and a conversation is an append-only log — the store's `appendMessages` leaves
// every row already in it alone. Those verbs stayed on the session surface (ISS-1004 step 5).
function CanonicalTurn({
  entry,
  streaming,
}: {
  entry: unknown;
  /** The live tail: drives the caret, and stops driving it when the turn settles. */
  streaming?: boolean;
}) {
  const items = parseMessages([entry]);
  if (items.length === 0) return null;
  return <Conversation items={items} readOnly streaming={streaming} />;
}

function Said({ message, corrected }: { message: ConversationMessage; corrected?: boolean }) {
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
  // cm:guard `blocks` are handed over when the row has them and the row's own text when it does not:
  // a message written before ISS-1029 carries `blocks: null` and is a text-only row, which
  // `parseMessages` reads through its `content` branch — so it renders as text rather than as an
  // empty turn (ISS-1078 criterion 12).
  return (
    <>
      {/* cm:guard the notice is drawn on the stored ROW and not only on the live turn: the row holds
          the replacement's text and carries nothing saying it replaced anything, so a marker that
          lived only as long as the streamed copy would give a person a second or two to notice a
          withdrawal. This is what keeps the correction from becoming a silent substitution that is
          merely late (ISS-1078, consult F5). */}
      {corrected && (
        <p className="fg-caption flex items-center gap-1.5 text-muted" data-testid="thread-correction">
          <Icon name="alert" size={12} className="flex-none" />
          The agent replaced what it was writing — this is the reply that was sent.
        </p>
      )}
      <CanonicalTurn
        entry={{
          id: message.id,
          type: "assistant",
          content: message.content,
          ...(message.blocks ? { blocks: message.blocks } : {}),
        }}
      />
    </>
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
        // cm:guard `accepted` renders NO line at all and not a third sentence: the server has the
        // message, so the row is simply a message now, and the one thing a label could still say —
        // "sent" — is what the bubble already says by being there. It is dropped when its durable
        // copy arrives, which is a frame later and not this one's business (ISS-1078 criterion 1).
        item.state !== "accepted" && (
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
  corrections = [],
  onRetry,
}: {
  messages: ConversationMessage[];
  windows: ConversationWindow[];
  /** What this browser has accepted and the server has not confirmed (ISS-1031). */
  outbox?: OutboxMessage[];
  /** The runner-hosted turns this room has held, as the server reads their state (ISS-1039). */
  agentTurns?: AgentTurn[];
  /** The turn being written right now, as the socket carries it (ISS-1078). */
  progress?: ConversationProgress | null;
  /** Entry ids this tab watched a draft be replaced under, so the stored row still says so. */
  corrections?: string[];
  onRetry?: (id: string) => void;
}) {
  const entries = threadEntries(messages, windows, outbox, agentTurns);
  // cm:guard the live turn is dropped the moment its own durable row is in `messages`, matched on
  // the entry id the socket streamed under and the row was written with: they are ONE turn, and
  // drawing both would show a person their answer twice for as long as the settle took. The id is
  // shared precisely so this reduction is an equality rather than a guess (ISS-1029 review F1).
  const liveId = (progress?.entry as { id?: string } | undefined)?.id;
  const settled = liveId !== undefined && messages.some((m) => m.id === liveId);
  return (
    <div className="flex flex-col gap-5">
      {entries.map((entry) => {
        if (entry.kind === "said")
          return (
            <Said
              key={entry.key}
              message={entry.message}
              corrected={corrections.includes(entry.message.id)}
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
      {/* cm:guard the live turn is appended AFTER every stored row and never interleaved, for the
          reason the outbox is: it has no `seq`, because it has not been written yet. */}
      {progress && !settled && (
        <div data-testid="thread-live-turn" data-replaced={progress.replaced ? "yes" : undefined}>
          {/* cm:guard a REPLACEMENT says so, above the text, rather than arriving in the draft's
              place: prose reaches this thread before the reply screen has judged it, and what pays
              for that is telling the reader the sentence they read was withdrawn. A silent swap is
              the substitution that decision refuses by name (core `messaging/doors.ts`,
              `web-chat-reply`). */}
          {progress.replaced && (
            <p className="fg-caption mb-1 flex items-center gap-1.5 text-muted" data-testid="thread-correction">
              <Icon name="alert" size={12} className="flex-none" />
              The agent replaced what it was writing — this is the reply that was sent.
            </p>
          )}
          {/* cm:guard the caret stops on a replacement AND on a settle, for the same reason in two
              shapes: the turn is over. One is the reply that went out and the other is the room
              saying it is done, and a caret under either says the agent is still writing. */}
          <CanonicalTurn
            entry={progress.entry}
            streaming={!progress.replaced && !progress.settled}
          />
        </div>
      )}
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
