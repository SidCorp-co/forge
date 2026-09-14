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

import { useMemo, useState } from "react";
import {
  AgentWorking,
  Banner,
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
import { conversationTitle } from "../types";
import { ConversationThread } from "./conversation-thread";

export function ConversationChat({
  projectId,
  conversationId,
  onClose,
  onConversationActive,
}: {
  projectId: string;
  /** Omitted = a draft: no room exists until the first message opens one. */
  conversationId?: string | undefined;
  /** When set, render a close control — the docked panel and the mobile overlay pass it. */
  onClose?: () => void;
  /** Fires once a draft's first send has opened a real room, so the caller can follow it. */
  onConversationActive?: (id: string) => void;
}) {
  const [activeId, setActiveId] = useState<string | undefined>(conversationId);
  const resolvedId = conversationId ?? activeId;

  const projectsQ = useProjects();
  const canWrite = projectsQ.data?.find((p) => p.id === projectId)?.role !== "viewer";

  const roomQ = useConversation(resolvedId);
  const open = useOpenConversation();
  const send = useSendMessage(resolvedId);

  const messages = useMemo(() => roomQ.data?.messages ?? [], [roomQ.data]);
  const windows = useMemo(() => roomQ.data?.windows ?? [], [roomQ.data]);
  const busy = send.isPending || open.isPending;

  const { scrollRef, bottomRef, onScroll } = useStickToBottom({
    conversationKey: resolvedId,
    ready: roomQ.isSuccess,
    itemCount: messages.length,
    live: busy,
  });

  // cm:guard the send is AWAITED and a failure rejects up into the composer, which is what keeps the typed text for a retry: resolving on a failure clears the box and the words are gone (ISS-462's contract, kept across the port).
  // cm:guard a draft opens its room and sends in ONE call chain, and the room id is adopted before the send: a send against a room the caller has not adopted would answer into a room this screen is not watching, and the reply would arrive nowhere.
  const handleSend = async (message: string) => {
    let id = resolvedId;
    if (!id) {
      id = (await open.mutateAsync({ projectId })).id;
      setActiveId(id);
      onConversationActive?.(id);
    }
    await send.mutateAsync(message);
  };

  if (resolvedId && roomQ.isLoading) {
    return (
      <div className="grid h-full min-h-0 place-items-center py-12">
        <ProjectLoader label="loading conversation…" />
      </div>
    );
  }

  if (resolvedId && roomQ.isError) {
    return (
      <div className="grid h-full min-h-0 place-items-center px-4 py-12">
        <ErrorState
          title="Couldn't load this conversation"
          message={formatApiError(roomQ.error)}
          onRetry={() => roomQ.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
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
          {onClose && <IconButton icon="x" size="sm" aria-label="Close conversation" onClick={onClose} />}
        </div>
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8 xl:max-w-4xl">
          {send.isError && (
            <div className="mb-6">
              <Banner tone="danger">
                <span className="font-medium">Couldn&apos;t send.</span> {formatApiError(send.error)}
              </Banner>
            </div>
          )}
          {messages.length === 0 ? (
            <div className="grid min-h-[40dvh] place-items-center">
              <EmptyState
                title="Start a conversation"
                message="Ask the agent anything about this project — its issues, its progress and what it knows."
                mascot
              />
            </div>
          ) : (
            <ConversationThread messages={messages} windows={windows} />
          )}
          {busy && (
            <div className="mt-6">
              <AgentWorking label="Agent is working…" />
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {canWrite ? (
        <Composer onSend={handleSend} busy={busy} sticky={false} />
      ) : (
        <ReadOnlyComposerNote sticky={false} />
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
