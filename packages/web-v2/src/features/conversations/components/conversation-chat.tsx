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
  EmptyState,
  ErrorState,
  IconButton,
  PageTitle,
  ProjectLoader,
} from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { Composer, ReadOnlyComposerNote } from "@/features/session/components/composer";
import {
  TurnStage,
  turnStageOf,
} from "@/features/session/components/turn-stage";
import { NewOutput } from "@/features/session/components/new-output";
import { useStickToBottom } from "@/features/session/components/use-stick-to-bottom";
import { parseMessages } from "@/features/session/types";
import { formatApiError } from "@/lib/api/error";
import {
  useConversation,
  useDraftAgentMode,
  useOpenConversation,
  useAcceptedMessages,
  useConversationProgress,
  useSendMessage,
  useWithdrawnDrafts,
} from "../hooks";
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
  /** When set, render the control that opens the conversation list. */
  onOpenHistory?: () => void;
  /** When set, render the control that drops back to a fresh draft. */
  onNew?: () => void;
  /** Rendered beneath the empty state of a room with no messages. */
  emptyBody?: React.ReactNode;
}) {
  const [activeId, setActiveId] = useState<string | undefined>(conversationId);
  const [membersOpen, setMembersOpen] = useState(false);
  const resolvedId = conversationId ?? activeId;

  const projectsQ = useProjects();
  const canWrite = projectsQ.data?.find((p) => p.id === projectId)?.role !== "viewer";

  const roomQ = useConversation(resolvedId);
  const accepted = useAcceptedMessages(resolvedId);
  const progress = useConversationProgress(resolvedId);
  const withdrawn = useWithdrawnDrafts(resolvedId);
  const streamedChars = useMemo(() => JSON.stringify(progress?.entry ?? null).length, [progress]);
  const open = useOpenConversation();
  const send = useSendMessage();

  const [outbox, setOutbox] = useState<OutboxMessage[]>([]);
  const sending = useRef(false);

  const [pick, setPick] = useState<ConversationMode>("assistant");

  const messages = useMemo(() => roomQ.data?.messages ?? [], [roomQ.data]);

  useEffect(() => {
    const seen = new Set(messages.map((m) => m.id));
    setOutbox((o) => {
      let moved = false;
      const next = o.flatMap((m) => {
        const ack = accepted[m.id];
        if (ack && seen.has(ack.messageId)) {
          moved = true;
          return [];
        }
        if (ack && m.state !== "sent") {
          moved = true;
          return [{ ...m, state: "sent" as const, messageId: ack.messageId }];
        }
        return [m];
      });
      return moved ? next : o;
    });
  }, [accepted, messages]);
  const windows = useMemo(() => roomQ.data?.windows ?? [], [roomQ.data]);
  const agentTurns = useMemo(() => roomQ.data?.agentTurns ?? [], [roomQ.data]);
  const busy = send.isPending || open.isPending;
  const streaming = busy || progress != null;

  const stage = turnStageOf({
    // `streaming` above is `busy || progress != null` and says the same thing for the same reason.
    live: streaming && !progress?.replaced,
    ...(progress ? { blocks: parseMessages([progress.entry])[0]?.blocks } : {}),
  });

  const settled = Boolean(roomQ.data && (roomQ.data.mode !== null || messages.length > 0));
  const draftOfferQ = useDraftAgentMode(projectId, !resolvedId);
  const agentOffer =
    roomQ.data?.agentMode ??
    draftOfferQ.data ?? { available: false, reason: "checking whether a box is free" };

  const refusal = roomQ.data ? composerRefusal(roomQ.data) : null;

  const { scrollRef, bottomRef, onScroll, atBottom, newOutput, toBottom } = useStickToBottom({
    conversationKey: resolvedId,
    ready: roomQ.isSuccess,
    itemCount: messages.length + outbox.length,
    live: busy,
    streaming,
    streamedChars,
  });

  const handleSend = async (message: string) => {
    setOutbox((o) => [...o, { id: crypto.randomUUID(), content: message, state: "queued" }]);
  };

  const retry = useCallback((id: string) => {
    setOutbox((o) => o.map((m) => (m.id === id ? { ...m, state: "queued", error: undefined } : m)));
  }, []);

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
        const fresh = !settled && messages.length === 0;
        await send.mutateAsync({
          conversationId: id,
          content: next.content,
          ...(fresh ? { mode: pick } : {}),
          clientToken: next.id,
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

  const header = (
    <header className="@container flex-none border-b border-line bg-app/95 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <PageTitle className="fg-h2 truncate">
            {roomQ.data ? conversationTitle(roomQ.data, messages[0]?.content) : "New conversation"}
          </PageTitle>
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
              atBottom={atBottom}
              messages={messages}
              windows={windows}
              outbox={outbox}
              progress={progress}
              withdrawn={withdrawn}
              agentTurns={agentTurns}
              onRetry={retry}
            />
          )}
          {stage && (
            <div className="mt-4">
              <TurnStage stage={stage} />
            </div>
          )}
          {newOutput && <NewOutput onGo={toBottom} />}
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
