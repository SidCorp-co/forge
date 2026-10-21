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

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EmptyState,
  ErrorState,
  IconButton,
  PageTitle,
  ProjectLoader,
} from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { CONVERSATION_ATTACHMENTS } from "@/features/chat/attachments";
import { ChatComposer, ReadOnlyComposerNote } from "@/features/chat/components/chat-composer";
import {
  TurnStage,
  turnStageOf,
} from "@/features/session/components/turn-stage";
import { NewOutput } from "@/features/session/components/new-output";
import { useStickToBottom } from "@/features/session/components/use-stick-to-bottom";
import { parseMessages } from "@/features/session/types";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import {
  useConversation,
  useDraftAgentMode,
  useOpenConversation,
  useAcceptedMessages,
  useConversationProgress,
  useSendMessage,
  useStopConversation,
  useUploadAttachment,
  useWithdrawnDrafts,
} from "../hooks";
import { composerRefusal } from "../membership";
import { isRoomGone, ROOM_DELETED_TITLE, roomDeletedLine, unsentLine } from "../room-gone";
import { type ConversationMode, type OutboxMessage, conversationTitle } from "../types";
import { ConversationModeControl, modePlaceholder } from "./mode-control";
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
  onRoomGone,
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
  /** Fires once this room is found deleted, so the caller can return the reader to the room list. */
  onRoomGone?: (id: string) => void;
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
  const upload = useUploadAttachment();
  const stop = useStopConversation();

  const [outbox, setOutbox] = useState<OutboxMessage[]>([]);
  const sending = useRef(false);
  /**
   * What a queued message has already put in storage, kept so a retry after a
   * failed send does not upload the same picture twice and leave the first copy
   * stored and cited by nothing.
   */
  const stored = useRef(new Map<string, string[]>());

  const [pick, setPick] = useState<ConversationMode>("assistant");

  // A room deleted while it was open says so once, leaves the list and hands the reader back to it:
  // a retry could only meet the same refusal (ISS-1229 r28, judge-80).
  const qc = useQueryClient();
  const { toast } = useToast();
  const [gone, setGone] = useState(false);
  const goneOnce = useRef(false);
  const roomWentAway = useCallback(
    (id: string, unsent: string | null) => {
      if (goneOnce.current) return;
      goneOnce.current = true;
      setGone(true);
      if (unsent === null) {
        toast({ title: ROOM_DELETED_TITLE, description: roomDeletedLine(false), tone: "error" });
      } else {
        // The thread that held the message goes with the room, so the notice keeps it until the
        // reader copies it or puts the notice away (ISS-1229 r29, judge-84).
        toast({
          title: ROOM_DELETED_TITLE,
          description: unsentLine(unsent),
          tone: "error",
          keep: true,
          onClick: () => {
            const copied = navigator.clipboard
              ? navigator.clipboard.writeText(unsent)
              : Promise.reject(new Error("no clipboard"));
            void copied.then(
              () => toast({ title: "What you wrote was copied", tone: "success" }),
              () =>
                toast({
                  title: "What you wrote could not be copied",
                  description: unsent,
                  tone: "error",
                  keep: true,
                }),
            );
          },
        });
      }
      qc.removeQueries({ queryKey: ["conversations", id], exact: true });
      void qc.invalidateQueries({ queryKey: ["conversations", "list"] });
      onRoomGone?.(id);
    },
    [qc, toast, onRoomGone],
  );
  useEffect(() => {
    if (resolvedId && roomQ.isError && isRoomGone(roomQ.error)) roomWentAway(resolvedId, null);
  }, [resolvedId, roomQ.isError, roomQ.error, roomWentAway]);

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
  const settledMode: ConversationMode | null = settled
    ? (roomQ.data?.mode ?? "assistant")
    : null;
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

  const handleSend = async (message: string, files: File[]) => {
    setOutbox((o) => [
      ...o,
      { id: crypto.randomUUID(), content: message, state: "queued", ...(files.length ? { files } : {}) },
    ]);
  };

  const retry = useCallback((id: string) => {
    if (goneOnce.current) return;
    setOutbox((o) => o.map((m) => (m.id === id ? { ...m, state: "queued", error: undefined } : m)));
  }, []);

  useEffect(() => {
    if (sending.current || gone) return;
    if (outbox.some((m) => m.state === "failed")) return;
    const next = outbox.find((m) => m.state === "queued");
    if (!next) return;
    sending.current = true;
    setOutbox((o) => o.map((m) => (m.id === next.id ? { ...m, state: "sending" } : m)));
    void (async () => {
      let id = resolvedId;
      try {
        if (!id) {
          id = (await open.mutateAsync({ projectId })).id;
          setActiveId(id);
          onConversationActive?.(id);
        }
        const fresh = !settled && messages.length === 0;
        const attachmentIds = [...(stored.current.get(next.id) ?? [])];
        for (const file of (next.files ?? []).slice(attachmentIds.length)) {
          const put = await upload.mutateAsync({ conversationId: id, file });
          attachmentIds.push(put.id);
          stored.current.set(next.id, [...attachmentIds]);
        }
        await send.mutateAsync({
          conversationId: id,
          content: next.content,
          ...(fresh ? { mode: pick } : {}),
          clientToken: next.id,
          ...(attachmentIds.length ? { attachmentIds } : {}),
        });
        stored.current.delete(next.id);
        setOutbox((o) => o.filter((m) => m.id !== next.id));
      } catch (err) {
        const roomGone = isRoomGone(err) && id !== undefined;
        setOutbox((o) =>
          o.map((m) =>
            m.id === next.id
              ? {
                  ...m,
                  state: "failed",
                  error: roomGone ? `${ROOM_DELETED_TITLE}. ${roomDeletedLine(true)}` : formatApiError(err),
                }
              : m,
          ),
        );
        if (roomGone && id) roomWentAway(id, next.content);
      } finally {
        sending.current = false;
      }
    })();
  }, [
    outbox,
    resolvedId,
    projectId,
    open,
    send,
    upload,
    onConversationActive,
    settled,
    messages.length,
    pick,
    gone,
    roomWentAway,
  ]);

  const header = (
    <header className="@container flex-none border-b border-line bg-app/95 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <PageTitle className="fg-h2 truncate">
            {roomQ.data ? conversationTitle(roomQ.data, messages[0]?.content) : "New conversation"}
          </PageTitle>
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

  if (gone) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="conversation-gone">
        {header}
        <div className="grid min-h-0 flex-1 place-items-center px-4 py-12">
          <EmptyState
            title={ROOM_DELETED_TITLE}
            message={roomDeletedLine(outbox.some((m) => m.state === "failed"))}
            {...(onNew ? { action: { label: "New conversation", onClick: onNew, icon: "plus" as const } } : {})}
          />
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
        <ChatComposer
          onSend={handleSend}
          busy={busy}
          queueWhileBusy
          sticky={false}
          attachments={CONVERSATION_ATTACHMENTS}
          placeholder={modePlaceholder(settledMode ?? pick)}
          {...(progress && resolvedId
            ? { onStop: () => stop.mutate(resolvedId), stopping: stop.isPending }
            : {})}
          footerControl={
            <ConversationModeControl
              value={pick}
              onChange={setPick}
              offer={agentOffer}
              settled={settledMode}
              disabled={busy}
            />
          }
        />
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
        action={{ label: "New conversation", onClick: onNew, icon: "plus" }}
      />
    </div>
  );
}
