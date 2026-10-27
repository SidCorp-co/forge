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
  SectionTitle,
  useMediaQuery,
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
import { useComposingMark, useMessageBoxFocus } from "../composing";
import {
  answeringAgentNames,
  composerRefusal,
  draftHeading,
  emptyRoomState,
  NO_AGENT_WILL_ANSWER,
  noAgentAnswers,
  NO_ACCESS_TITLE,
  refusedForScope,
  viewerCannotPost,
} from "../membership";
import { isRoomGone, type KeptCopy, ROOM_DELETED_TITLE, roomDeletedLine, unsentLine } from "../room-gone";
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
  namesTab = false,
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
  /** The room fills the page, so its title names the browser tab too; a docked panel leaves the tab to its page. */
  namesTab?: boolean;
}) {
  const [activeId, setActiveId] = useState<string | undefined>(conversationId);
  const [membersOpen, setMembersOpen] = useState(false);
  const resolvedId = conversationId ?? activeId;

  const projectsQ = useProjects();
  const project = projectsQ.data?.find((p) => p.id === projectId);

  const roomQ = useConversation(resolvedId);
  // A reader posts only where they hold more than the viewer role on every project the room is about,
  // so a viewer of either project of a two-project room is told they can read it (ISS-1229 r35).
  const roomProjects = roomQ.data?.scopeProjects?.length ? roomQ.data.scopeProjects : project ? [project] : [];
  const viewedOnly =
    roomProjects.find((p) => projectsQ.data?.find((mine) => mine.id === p.id)?.role === "viewer") ??
    (project?.role === "viewer" ? project : undefined);
  const canWrite = !viewedOnly;
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

  // On a phone the thread gets the room while its message box has focus (ISS-1229 r32, judge-90).
  const box = useMessageBoxFocus<HTMLDivElement>();
  const wide = useMediaQuery("(min-width: 768px)");
  const composing = box.focused && !wide;
  useComposingMark(composing);

  // A room deleted while it was open says so once, leaves the list and hands the reader back to it:
  // a retry could only meet the same refusal (ISS-1229 r28, judge-80).
  const qc = useQueryClient();
  const { toast } = useToast();
  const [gone, setGone] = useState(false);
  const goneOnce = useRef(false);
  // The thread that held an unsent message goes with the room, so its notice keeps the text until the
  // reader copies it or puts the notice away (ISS-1229 r29, judge-84). Copying says so in that notice,
  // where the reader is looking: a second toast landed over the room list on a phone (r31, judge-88).
  // A copy the browser refuses turns the notice into one to copy by hand, with no tap left to fail the
  // same way again (r32, judge-90).
  const keepUnsent = useCallback(
    (unsent: string, sent: boolean) => {
      // Its own slot for good: a notice left up by an earlier mount of this room must not be replaced.
      const slot = `room-gone-unsent-${crypto.randomUUID()}`;
      const show = (copy: KeptCopy) => {
        const byHand = copy === "by-hand" || copy === "refused";
        toast({
          title: ROOM_DELETED_TITLE,
          description: unsentLine(unsent, sent, copy),
          tone: "error",
          keep: true,
          slot,
          ...(byHand
            ? { verbatim: true }
            : {
                onClick: () => {
                  void navigator.clipboard.writeText(unsent).then(
                    () => show("copied"),
                    () => show("refused"),
                  );
                },
              }),
        });
      };
      show(typeof navigator.clipboard?.writeText === "function" ? "offered" : "by-hand");
    },
    [toast],
  );
  const roomWentAway = useCallback(
    (id: string, unsent: string | null, sent: boolean) => {
      // A send refused after a re-read already found the room gone still hands back its text (r29 F2).
      if (goneOnce.current) {
        if (unsent !== null) keepUnsent(unsent, sent);
        return;
      }
      goneOnce.current = true;
      setGone(true);
      if (unsent === null) {
        toast({ title: ROOM_DELETED_TITLE, description: roomDeletedLine(false), tone: "error" });
      } else {
        keepUnsent(unsent, sent);
      }
      qc.removeQueries({ queryKey: ["conversations", id], exact: true });
      void qc.invalidateQueries({ queryKey: ["conversations", "list"] });
      onRoomGone?.(id);
    },
    [qc, toast, onRoomGone, keepUnsent],
  );
  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;
  // What the box holds and has not sent goes with the room too, so the notice keeps it (r30, judge-86).
  const draft = useRef("");
  const onDraftChange = useCallback((text: string) => {
    draft.current = text;
  }, []);
  /** The draft as typed, where it holds something not already among `sent` (r30 review F2). */
  const draftBeside = useCallback((sent: readonly string[]): string | null => {
    const typed = draft.current;
    const seen = typed.trim();
    return seen && !sent.some((s) => s.trim() === seen) ? typed : null;
  }, []);
  useEffect(() => {
    if (!resolvedId || !roomQ.isError || !isRoomGone(roomQ.error)) return;
    // Messages still waiting their turn will never be sent; one being sent says so when it is refused.
    const waiting = outboxRef.current.filter((m) => m.state === "queued").map((m) => m.content);
    const typed = draftBeside(waiting);
    const unsent = typed === null ? waiting : [...waiting, typed];
    roomWentAway(resolvedId, unsent.length > 0 ? unsent.join("\n\n") : null, waiting.length > 0);
  }, [resolvedId, roomQ.isError, roomQ.error, roomWentAway, draftBeside]);

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
    draftOfferQ.data ?? { available: false, reason: "checking whether a box is free", unbound: null };

  const refusal = roomQ.data ? composerRefusal(roomQ.data, { canPost: canWrite }) : null;
  // A room no agent can answer, or one the reader cannot post in, says so rather than inviting (r34); a
  // person who may post still may, and the box and the thread say who cannot answer and why (r35).
  const empty = emptyRoomState(roomQ.data, { canPost: canWrite, projectName: viewedOnly?.name ?? project?.name });
  const unanswered = roomQ.data ? noAgentAnswers(roomQ.data) : null;
  // The agents the header says answer here, by the same handles, for the box to name.
  const answerers = roomQ.data ? answeringAgentNames(roomQ.data) : [];

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
        if (roomGone && id) {
          const typed = draftBeside([next.content]);
          roomWentAway(id, typed === null ? next.content : `${next.content}\n\n${typed}`, true);
        }
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
    draftBeside,
  ]);

  const heading = roomQ.data ? conversationTitle(roomQ.data, messages[0]?.content) : draftHeading(resolvedId, canWrite);
  const unread = Boolean(resolvedId && roomQ.isError && outbox.length === 0 && !gone);
  const header = (
    <header className="@container flex-none border-b border-line bg-app/95 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          {/* The room heads the page only on Conversations, and not while a state about its read does (ISS-1229 r47). */}
          {namesTab ? (
            <PageTitle className="fg-h2 truncate" heads={!unread}>
              {heading}
            </PageTitle>
          ) : (
            <SectionTitle className="fg-h2 truncate">{heading}</SectionTitle>
          )}
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

  if (unread) {
    const level = namesTab ? 1 : 2;
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <div className="grid min-h-0 flex-1 place-items-center px-4 py-12">
          {refusedForScope(roomQ.error) ? (
            <ErrorState level={level} title={NO_ACCESS_TITLE} message={roomQ.error.message} final />
          ) : (
            <ErrorState
              level={level}
              title="Couldn't load this conversation"
              message={formatApiError(roomQ.error)}
              onRetry={() => roomQ.refetch()}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}

      {roomQ.data && <ScopeNotice room={roomQ.data} folded={composing} canPost={canWrite} />}

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8 xl:max-w-4xl">
          {messages.length === 0 && outbox.length === 0 ? (
            <div className="flex min-h-[40dvh] flex-col">
              <div className="grid flex-1 place-items-center" data-testid="conversation-empty">
                <EmptyState
                  title={empty?.title ?? "Start a conversation"}
                  message={
                    empty?.message ??
                    "Ask the agent anything about this project — its issues, its progress and what it knows."
                  }
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
              participants={roomQ.data?.participants ?? []}
              agentTurns={agentTurns}
              onRetry={retry}
              unanswered={unanswered}
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

      {!canWrite ? (
        <ReadOnlyComposerNote sticky={false} says={viewerCannotPost(viewedOnly?.name ?? "this project")} />
      ) : refusal ? (
        <div className="flex-none border-t border-line bg-surface px-4 py-3" data-testid="composer-refused">
          <p className="fg-body-sm text-fg">{refusal.reason}</p>
          {refusal.wayOut && <p className="fg-caption mt-0.5 text-muted">{refusal.wayOut}</p>}
        </div>
      ) : (
        <div className="flex-none" ref={box.ref}>
        {unanswered && (
          <div className="border-t border-line bg-surface px-4 py-2" data-testid="composer-no-answer">
            <p className="fg-body-sm text-fg">{NO_AGENT_WILL_ANSWER}</p>
            {unanswered.map((line) => (
              <p key={line} className="fg-caption mt-0.5 text-muted">
                {line}
              </p>
            ))}
          </div>
        )}
        <ChatComposer
          onSend={handleSend}
          busy={busy}
          queueWhileBusy
          sticky={false}
          attachments={CONVERSATION_ATTACHMENTS}
          placeholder={unanswered ? "Message the room — no agent here will answer" : modePlaceholder(settledMode ?? pick, answerers)}
          onDraftChange={onDraftChange}
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
        </div>
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
