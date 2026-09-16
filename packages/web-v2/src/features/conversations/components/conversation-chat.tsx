"use client";

// One conversation, open: its thread, and the box you type in.
//
// This replaces `features/session/components/chat-screen.tsx` (ISS-1004 step 5).
// What it deliberately does not carry, and where each went: model pick and
// runner pick name the tier and the device a RUN uses; fork, rerun, per-turn
// edit and regenerate all rewrite a run's turns. A conversation is an
// append-only log — the store's own `appendMessages` leaves every row already in
// it alone — so all six stayed on the session surface, which keeps every
// run-shaped verb it had.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AgentWorking,
  EmptyState,
  ErrorState,
  IconButton,
  ProjectLoader,
} from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { Composer, ReadOnlyComposerNote } from "@/features/session/components/composer";
import { useStickToBottom } from "@/features/session/components/use-stick-to-bottom";
import { formatApiError } from "@/lib/api/error";
import { useConversation, useOpenConversation, useSendMessage } from "../hooks";
import { composerRefusal } from "../membership";
import { type ConversationMode, type OutboxMessage, conversationTitle } from "../types";
import { ConversationModeToggle } from "./conversation-mode-toggle";
import { ConversationMembers } from "./conversation-members";
import { ConversationThread } from "./conversation-thread";
import { ScopeNotice } from "./scope-notice";

export function ConversationChat({
  projectId,
  conversationId,
  onClose,
  onConversationActive,
  onOpenHistory,
  onNew,
  emptyBody,
}: {
  projectId: string;
  /** Omitted = a draft: no room exists until the first message opens one. */
  conversationId?: string | undefined;
  /** When set, render a close control — the docked panel and the mobile overlay pass it. */
  onClose?: () => void;
  /** Fires once a draft's first send has opened a real room, so the caller can follow it. */
  onConversationActive?: (id: string) => void;
  // cm:guard the way into the list is a control in THIS header rather than a link to the
  // `/conversations` page: the panel exists so a person never leaves the screen they are on, and
  // ISS-732's promise that history stayed reachable was kept on that page and nowhere here, which
  // is what made closing the panel read as losing the conversation (ISS-1028).
  /** When set, render the control that opens the conversation list. */
  onOpenHistory?: () => void;
  /** When set, render the control that drops back to a fresh draft. */
  onNew?: () => void;
  // cm:guard rendered UNDER the empty state and only while the room holds nothing, so the list is
  // on screen the moment the panel opens without a single room being resumed: the issue asks for
  // both a new draft on open and the list on open, and this is what makes them one screen.
  /** Rendered beneath the empty state of a room with no messages. */
  emptyBody?: React.ReactNode;
}) {
  const [activeId, setActiveId] = useState<string | undefined>(conversationId);
  const [membersOpen, setMembersOpen] = useState(false);
  const resolvedId = conversationId ?? activeId;

  const projectsQ = useProjects();
  const canWrite = projectsQ.data?.find((p) => p.id === projectId)?.role !== "viewer";

  const roomQ = useConversation(resolvedId);
  const open = useOpenConversation();
  const send = useSendMessage();

  // cm:guard the outbox lives HERE and not in the query cache: the first message of a room creates
  // the conversation before it can send, so at the moment a person presses Enter there is no cache
  // entry to write an optimistic row into — `setQueryData` would find nothing and drop it silently,
  // which is the exact failure this is fixing (ISS-1031).
  const [outbox, setOutbox] = useState<OutboxMessage[]>([]);
  const sending = useRef(false);

  // cm:guard the pick lives in this component's state and NOT in the query cache, because until the
  // first send there is no room to hold it: a draft has no conversation row at all, and the room a
  // first send opens gets its mode from the same request that carries the message (ISS-1039).
  const [pick, setPick] = useState<ConversationMode>("assistant");

  const messages = useMemo(() => roomQ.data?.messages ?? [], [roomQ.data]);
  const windows = useMemo(() => roomQ.data?.windows ?? [], [roomQ.data]);
  const agentTurns = useMemo(() => roomQ.data?.agentTurns ?? [], [roomQ.data]);
  const busy = send.isPending || open.isPending;

  // cm:guard the control is live while the room is EMPTY and by no other test: a room whose column
  // is still null but which already holds a transcript was opened before ISS-1039 and answers in
  // Assistant mode, and offering the pick over it would offer something the server refuses. A draft
  // holds no room at all, which is the emptiest a room gets.
  const settled = Boolean(roomQ.data && (roomQ.data.mode !== null || messages.length > 0));
  // cm:guard a DRAFT offers Agent on the strength of nothing, because there is no room to ask
  // about yet: the send is where the truth is told, and it refuses by name rather than falling back.
  // Once a room exists the server's own answer is what the control reads (ISS-1039).
  const agentOffer = roomQ.data?.agentMode ?? { available: true, reason: null };

  // cm:guard the composer is CLOSED before a person types rather than after they press enter, because the server refuses a turn in a room about more than one project by name — and a person who has written a paragraph into a box that was never going to send it has lost the paragraph and learned nothing. The reason and the way out below are the same ones that refusal carries (ISS-1011 criterion 33).
  const refusal = roomQ.data ? composerRefusal(roomQ.data) : null;

  const { scrollRef, bottomRef, onScroll } = useStickToBottom({
    conversationKey: resolvedId,
    ready: roomQ.isSuccess,
    itemCount: messages.length + outbox.length,
    live: busy,
  });

  // cm:guard the send is AWAITED and a failure rejects up into the composer, which is what keeps the typed text for a retry: resolving on a failure clears the box and the words are gone (ISS-462's contract, kept across the port).
  // cm:guard the id that just came back from `open` is handed to the send DIRECTLY and not read off `resolvedId`: state set in this same chain has not re-rendered yet, so the render's value is still undefined and the send would post to `/conversations/undefined/messages` (review F3).
  // cm:guard this RETURNS as soon as the message is in the outbox and never awaits the round-trip.
  // The composer clears on return, so the words leave the box the moment Enter is pressed and the
  // thread shows them immediately; the send itself is driven by the drain below. Awaiting here is
  // what made a person wait out the whole agent turn before seeing their own question (ISS-1031).
  const handleSend = async (message: string) => {
    setOutbox((o) => [...o, { id: crypto.randomUUID(), content: message, state: "queued" }]);
  };

  const retry = useCallback((id: string) => {
    setOutbox((o) => o.map((m) => (m.id === id ? { ...m, state: "queued", error: undefined } : m)));
  }, []);

  // cm:guard ONE send in flight per room, held by a ref rather than by `send.isPending`: the flag is
  // state and lags a render behind, so two queued messages both read it as free and both post. The
  // server serialises a room's windows, so the second would answer against a window the first had
  // already claimed.
  // cm:guard a failure STOPS the drain and keeps every message behind it queued rather than sending
  // them into a room whose earlier question was refused — and the failed one keeps its words, which
  // is ISS-462's contract carried onto the row instead of onto the box.
  useEffect(() => {
    if (sending.current) return;
    if (outbox.some((m) => m.state === "failed")) return;
    const next = outbox.find((m) => m.state === "queued");
    if (!next) return;
    sending.current = true;
    setOutbox((o) => o.map((m) => (m.id === next.id ? { ...m, state: "sending" } : m)));
    void (async () => {
      try {
        let id = resolvedId;
        if (!id) {
          id = (await open.mutateAsync({ projectId })).id;
          setActiveId(id);
          onConversationActive?.(id);
        }
        // cm:guard the mode rides the FIRST message and no other, which is what the server accepts:
        // it is settled inside the transaction that commits that message, and a later send carrying
        // one is refused by name. `fresh` is true of a draft's own first send too, where the room
        // was opened three lines above and holds nothing yet.
        const fresh = !settled && messages.length === 0;
        await send.mutateAsync({
          conversationId: id,
          content: next.content,
          ...(fresh ? { mode: pick } : {}),
        });
        setOutbox((o) => o.filter((m) => m.id !== next.id));
      } catch (err) {
        setOutbox((o) =>
          o.map((m) =>
            m.id === next.id ? { ...m, state: "failed", error: formatApiError(err) } : m,
          ),
        );
      } finally {
        sending.current = false;
      }
    })();
  }, [outbox, resolvedId, projectId, open, send, onConversationActive, settled, messages.length, pick]);

  // cm:guard the header is built ONCE and rendered above every body state, rather than the loading
  // and error states returning a screen of their own: a room whose read fails — one deleted in
  // another tab, a dropped connection — used to render as an error and a Retry button with no
  // history control and no way to start a new chat, so the only way out of a room that no longer
  // loads was to close the panel and open it again (review F3).
  const header = (
    <header className="@container flex-none border-b border-line bg-app/95 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="fg-h2 truncate">
            {roomQ.data ? conversationTitle(roomQ.data, messages[0]?.content) : "New conversation"}
          </h1>
          <p className="fg-body-sm hidden text-muted @[560px]:block">
            Ask the agent about this project — it reads the project, not the repository.
          </p>
        </div>
        {onOpenHistory && (
          <IconButton
            icon="clock"
            size="sm"
            aria-label="Conversation history"
            onClick={onOpenHistory}
          />
        )}
        {onNew && <IconButton icon="plus" size="sm" aria-label="New conversation" onClick={onNew} />}
        {roomQ.data && (
          <IconButton
            icon="users"
            size="sm"
            aria-label="Who is in this room"
            onClick={() => setMembersOpen(true)}
          />
        )}
        {onClose && <IconButton icon="x" size="sm" aria-label="Close conversation" onClick={onClose} />}
      </div>
    </header>
  );

  // cm:guard the loader yields to anything of the person's OWN that is not sent yet. The first send
  // of a draft opens the room, which starts this query, which replaced the whole thread — including
  // the question they had just typed — with a spinner. Showing a spinner over somebody's unsent
  // words is the same defect as never showing them at all (ISS-1031).
  if (resolvedId && roomQ.isLoading && outbox.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <div className="grid min-h-0 flex-1 place-items-center py-12">
          <ProjectLoader label="loading conversation…" />
        </div>
      </div>
    );
  }

  // cm:guard the error state yields to an unsent message for the same reason the loader above does,
  // and this one matters more: a room that will not load is exactly when a person needs the words
  // they typed handed back rather than replaced by a Retry button. The failed row carries them and
  // the header still offers the way out ISS-1028 added (ISS-1031).
  if (resolvedId && roomQ.isError && outbox.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <div className="grid min-h-0 flex-1 place-items-center px-4 py-12">
          <ErrorState
            title="Couldn't load this conversation"
            message={formatApiError(roomQ.error)}
            onRetry={() => roomQ.refetch()}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}

      {roomQ.data && <ScopeNotice room={roomQ.data} />}

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8 xl:max-w-4xl">
          {messages.length === 0 && outbox.length === 0 ? (
            <div className="flex min-h-[40dvh] flex-col">
              <div className="grid flex-1 place-items-center">
                <EmptyState
                  title="Start a conversation"
                  message="Ask the agent anything about this project — its issues, its progress and what it knows."
                  mascot
                />
              </div>
              {emptyBody}
            </div>
          ) : (
            <ConversationThread
              messages={messages}
              windows={windows}
              outbox={outbox}
              agentTurns={agentTurns}
              onRetry={retry}
            />
          )}
          {busy && (
            <div className="mt-6">
              <AgentWorking label="Agent is working…" />
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {refusal ? (
        <div className="flex-none border-t border-line bg-surface px-4 py-3" data-testid="composer-refused">
          <p className="fg-body-sm text-fg">{refusal.reason}</p>
          <p className="fg-caption mt-0.5 text-muted">{refusal.wayOut}</p>
        </div>
      ) : canWrite ? (
        <>
          {/* cm:guard rendered only while the room is unsettled, which is the whole of the rule: the
              first send writes the mode, and from the second turn on there is no control offering
              it because there is nothing left to offer (ISS-1039). */}
          {!settled && (
            <ConversationModeToggle
              value={pick}
              onChange={setPick}
              offer={agentOffer}
              disabled={busy}
            />
          )}
          <Composer onSend={handleSend} busy={busy} queueWhileBusy sticky={false} />
        </>
      ) : (
        <ReadOnlyComposerNote sticky={false} />
      )}

      {roomQ.data?.participants && resolvedId && (
        <ConversationMembers
          conversationId={resolvedId}
          room={roomQ.data}
          canChange={roomQ.data.canChangeMembership === true}
          open={membersOpen}
          onClose={() => setMembersOpen(false)}
        />
      )}
    </div>
  );
}

/** The "no room open yet" state, with a way into one. */
export function NoConversationOpen({ onNew }: { onNew: () => void }) {
  return (
    <div className="grid h-full min-h-0 place-items-center px-4">
      <EmptyState
        title="No conversation open"
        message="Pick one from the list, or start a new one."
        action={{ label: "New conversation", onClick: onNew }}
      />
    </div>
  );
}
