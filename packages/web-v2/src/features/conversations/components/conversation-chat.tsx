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
import { ThreadDataProvider } from "@/features/onboarding/components/thread-blocks";
import { useProjects } from "@/features/projects/hooks";
import { canWriteProject } from "@/features/projects/write-access";
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
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
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
import type { ConversationMode, OutboxMessage } from "../types";
import { ComposerFooter, RoomEmpty, RoomHeader, RoomLoading, RoomUnreadable, useComposerPlaceholder } from "./conversation-room-parts";
import { ConversationMembers } from "./conversation-members";
import { ConversationThread } from "./conversation-thread";
import { ScopeNotice } from "./scope-notice";
import { seesDetail, useUiActions, useUiSnapshot } from "../ui-actions/use-ui-actions";
import { useActOffers } from "../act-offers";
import { turnDoing } from "../turn-doing";

export function ConversationChat({
  projectId,
  conversationId,
  onConversationActive,
  initialDraft,
  ecosystemId,
  headerActions,
  scopeChip,
}: {
  projectId: string;
  /** Omitted = a draft: no room exists until the first message opens one. */
  conversationId?: string | undefined;
  /** Fires once a draft's first send has opened a real room, so the caller can follow it. */
  onConversationActive?: (id: string) => void;
  initialDraft?: string;
  ecosystemId?: string | null;
  headerActions?: React.ReactNode;
  scopeChip?: React.ReactNode;
}) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const [activeId, setActiveId] = useState<string | undefined>(conversationId);
  const [membersOpen, setMembersOpen] = useState(false);
  const resolvedId = conversationId ?? activeId;

  const projectRow = useProjects().data?.find((p) => p.id === projectId);
  const canWrite = canWriteProject(projectRow?.role);

  const roomQ = useConversation(resolvedId);
  const progress = useConversationProgress(resolvedId);
  const withdrawn = useWithdrawnDrafts(resolvedId);
  const streamedChars = useMemo(() => JSON.stringify(progress?.entry ?? null).length, [progress]);
  const stop = useStopConversation();

  const [pick, setPick] = useState<ConversationMode>("assistant");

  const messages = useMemo(() => roomQ.data?.messages ?? [], [roomQ.data]);
  const page = useUiSnapshot(projectRow?.slug);
  const pageRef = useRef(page);
  pageRef.current = page;
  const ui = useUiActions({
    slug: projectRow?.slug ?? "",
    ready: Boolean(projectRow) && (!resolvedId || roomQ.isSuccess),
    messages,
    progress,
  });
  const settled = Boolean(roomQ.data && (roomQ.data.mode !== null || messages.length > 0));
  const onOpened = useCallback(
    (id: string) => {
      setActiveId(id);
      onConversationActive?.(id);
    },
    [onConversationActive],
  );
  const snapshot = useCallback(() => pageRef.current, []);
  const { outbox, enqueue: handleSend, retry, busy } = useOutbox({
    resolvedId,
    projectId,
    ecosystemId,
    onOpened,
    messages,
    settled,
    pick,
    snapshot,
  });
  const windows = useMemo(() => roomQ.data?.windows ?? [], [roomQ.data]);
  const agentTurns = useMemo(() => roomQ.data?.agentTurns ?? [], [roomQ.data]);
  const streaming = busy || progress != null;

  const liveBlocks = progress ? parseMessages([progress.entry])[0]?.blocks : undefined;
  const stage = turnStageOf({
    // `streaming` above is `busy || progress != null` and says the same thing for the same reason.
    live: streaming && !progress?.replaced,
    ...(progress ? { blocks: liveBlocks } : {}),
  });
  const doing = stage === "working" ? turnDoing(liveBlocks, t) : null;
  const acts = useActOffers({ messages, progress });
  const afterEntry = useCallback(
    (entryId: string) => {
      const cards = ui.cardsFor(entryId);
      const offers = acts.offersFor(entryId);
      return cards || offers ? (
        <>
          {cards}
          {offers}
        </>
      ) : null;
    },
    [ui.cardsFor, acts.offersFor],
  );

  const settledMode: ConversationMode | null = settled ? (roomQ.data?.mode ?? "assistant") : null;
  const draftOfferQ = useDraftAgentMode(projectId, !resolvedId);
  const agentOffer =
    roomQ.data?.agentMode ??
    draftOfferQ.data ?? { available: false, reason: t("conversations.agentOfferChecking") };

  const refusal = roomQ.data ? composerRefusal(roomQ.data, t) : null;

  const { scrollRef, bottomRef, onScroll, atBottom, newOutput, toBottom } = useStickToBottom({
    conversationKey: resolvedId,
    ready: roomQ.isSuccess,
    itemCount: messages.length + outbox.length,
    live: busy,
    streaming,
    streamedChars,
  });

  const onboardingRoom = roomQ.data?.kind === "onboarding";
  const placeholder = useComposerPlaceholder(onboardingRoom, settledMode ?? pick);
  const header = (
    <RoomHeader
      room={roomQ.data}
      firstSaid={messages[0]?.content}
      projectId={projectId}
      onMembers={() => setMembersOpen(true)}
      actions={headerActions}
    />
  );

  if (resolvedId && roomQ.isLoading && outbox.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <RoomLoading />
      </div>
    );
  }

  if (resolvedId && roomQ.isError && outbox.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <RoomUnreadable error={roomQ.error} onRetry={() => roomQ.refetch()} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}

      {roomQ.data && <ScopeNotice room={roomQ.data} />}

      <div ref={scrollRef} onScroll={onScroll} className="@container min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-3 py-3 @2xl:px-8 @2xl:py-8 xl:max-w-4xl">
          {messages.length === 0 && outbox.length === 0 ? (
            <RoomEmpty />
          ) : (
            <ThreadDataProvider
              value={{
                projectId,
                projectSlug: projectRow?.slug,
                conversationId: resolvedId ?? "",
                kind: roomQ.data?.kind ?? null,
                questionnaires: roomQ.data?.questionnaires ?? [],
              }}
            >
            <ConversationThread
              projectSlug={projectRow?.slug}
              atBottom={atBottom}
              messages={messages}
              windows={windows}
              outbox={outbox}
              progress={progress}
              withdrawn={withdrawn}
              agentTurns={agentTurns}
              onRetry={retry}
              afterEntry={afterEntry}
            />
            </ThreadDataProvider>
          )}
          {stage && (
            <div className="mt-4">
              <TurnStage stage={stage} detail={doing} />
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
          placeholder={placeholder}
          {...(progress && resolvedId
            ? { onStop: () => stop.mutate(resolvedId), stopping: stop.isPending }
            : {})}
          {...(initialDraft ? { initialValue: initialDraft } : {})}
          footerControl={
            <ComposerFooter
              onboarding={onboardingRoom}
              mode={{ value: pick, onChange: setPick, offer: agentOffer, settled: settledMode, disabled: busy }}
              scopeChip={scopeChip}
              sees={page.sees ? { label: page.sees, detail: seesDetail(page.snapshot, { project: projectRow?.name ?? null, scope: ecosystemId ? "ecosystem" : "project" }, t, language) } : null}
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

/** The messages typed but not yet in the thread: queued, sent one at a time (opening the room on a draft's first), and retried on failure. */
function useOutbox(o: {
  resolvedId: string | undefined;
  projectId: string;
  ecosystemId: string | null | undefined;
  onOpened: (id: string) => void;
  messages: ReadonlyArray<{ id: string }>;
  settled: boolean;
  pick: ConversationMode;
  snapshot: () => ReturnType<typeof useUiSnapshot>;
}) {
  const { resolvedId, projectId, ecosystemId, onOpened, messages, settled, pick, snapshot } = o;
  const accepted = useAcceptedMessages(resolvedId);
  const open = useOpenConversation();
  const send = useSendMessage();
  const upload = useUploadAttachment();
  const [outbox, setOutbox] = useState<OutboxMessage[]>([]);
  const sending = useRef(false);
  /**
   * What a queued message has already put in storage, kept so a retry after a
   * failed send does not upload the same picture twice and leave the first copy
   * stored and cited by nothing.
   */
  const stored = useRef(new Map<string, string[]>());

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

  const enqueue = async (message: string, files: File[]) => {
    setOutbox((o) => [
      ...o,
      { id: crypto.randomUUID(), content: message, state: "queued", ...(files.length ? { files } : {}) },
    ]);
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
          id = (await open.mutateAsync({ projectId, ecosystemId: ecosystemId ?? null })).id;
          onOpened(id);
        }
        const fresh = !settled && messages.length === 0;
        const attachmentIds = [...(stored.current.get(next.id) ?? [])];
        for (const file of (next.files ?? []).slice(attachmentIds.length)) {
          // one operation per queued message and file position: a retry of this message sends the same id
          const operationId = `${next.id}:${attachmentIds.length}`;
          const put = await upload.mutateAsync({ conversationId: id, file, operationId });
          attachmentIds.push(put.id);
          stored.current.set(next.id, [...attachmentIds]);
        }
        await send.mutateAsync({
          conversationId: id,
          content: next.content,
          ...(fresh ? { mode: pick } : {}),
          clientToken: next.id,
          ...(attachmentIds.length ? { attachmentIds } : {}),
          ...(snapshot().sees ? { uiSnapshot: snapshot().snapshot } : {}),
        });
        stored.current.delete(next.id);
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
  }, [
    outbox,
    resolvedId,
    projectId,
    open,
    send,
    upload,
    onOpened,
    ecosystemId,
    settled,
    messages.length,
    pick,
    snapshot,
  ]);

  return { outbox, enqueue, retry, busy: send.isPending || open.isPending };
}
