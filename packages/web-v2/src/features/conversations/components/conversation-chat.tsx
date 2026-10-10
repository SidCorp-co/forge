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

import { type ComponentProps, type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { ThreadDataProvider } from "@/features/onboarding";
import { useProjects } from "@/features/projects";
import { canWriteProject } from "@/features/projects";
import { CONVERSATION_ATTACHMENTS } from "@/features/chat";
import { ChatComposer, ReadOnlyComposerNote } from "@/features/chat";
import {
  TurnStage,
  turnStageOf,
} from "@/features/session";
import { NewOutput } from "@/features/session";
import { useStickToBottom } from "@/features/session";
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
import { type ConversationMode, liveRenderBlocks, type OutboxMessage } from "../types";
import { ComposerFooter, RoomEmpty, RoomHeader, RoomLoading, RoomUnreadable, useComposerPlaceholder } from "./conversation-room-parts";
import { ConversationMembers } from "./conversation-members";
import { ConversationThread } from "./conversation-thread";
import { ScopeNotice } from "./scope-notice";
import { seesDetail, useUiActions, useUiSnapshot } from "../ui-actions/use-ui-actions";
import { useActOffers } from "../act-offers";
import { ProposalCards } from "./proposal-cards";
import { turnDoing } from "../turn-doing";

const NONE: never[] = [];

/** The running turn's stage, and what it is doing while it works. */
function turnNow(progress: ReturnType<typeof useConversationProgress>, streaming: boolean, t: ReturnType<typeof useCopy>) {
  const liveBlocks = progress ? liveRenderBlocks(progress) : undefined;
  const stage = turnStageOf({
    // `streaming` is `busy || progress != null` and says the same thing for the same reason.
    live: streaming && !progress?.replaced && !progress?.verdict,
    ...(progress ? { blocks: liveBlocks } : {}),
  });
  return { stage, doing: stage === "working" ? turnDoing(liveBlocks, t) : null };
}

/** Where the person writes: the composer, or why this room takes nothing from them. */
function RoomComposer({ refusal, canWrite, composer }: { refusal: ReturnType<typeof composerRefusal> | null; canWrite: boolean; composer: ComponentProps<typeof ChatComposer> }) {
  if (refusal) {
    return (
      <div className="flex-none border-t border-line bg-surface px-4 py-3" data-testid="composer-refused">
        <p className="fg-body-sm text-fg">{refusal.reason}</p>
        <p className="fg-caption mt-0.5 text-muted">{refusal.wayOut}</p>
      </div>
    );
  }
  return canWrite ? <ChatComposer {...composer} /> : <ReadOnlyComposerNote sticky={false} />;
}

/** The thread as it scrolls: what was said, the turn running now, and a way down to new output. */
function RoomScroll({
  scroll,
  empty,
  data,
  thread,
  stage,
}: {
  scroll: { scrollRef: RefObject<HTMLDivElement | null>; bottomRef: RefObject<HTMLDivElement | null>; onScroll: () => void; newOutput: boolean; toBottom: () => void };
  empty: boolean;
  data: ComponentProps<typeof ThreadDataProvider>["value"];
  thread: ComponentProps<typeof ConversationThread>;
  stage: ReactNode;
}) {
  return (
    <div ref={scroll.scrollRef} onScroll={scroll.onScroll} className="@container min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-3 py-3 @2xl:px-8 @2xl:py-8 xl:max-w-4xl">
        {empty ? (
          <RoomEmpty />
        ) : (
          <ThreadDataProvider value={data}>
            <ConversationThread {...thread} />
          </ThreadDataProvider>
        )}
        {stage ? <div className="mt-4">{stage}</div> : null}
        {scroll.newOutput && <NewOutput onGo={scroll.toBottom} />}
        <div ref={scroll.bottomRef} />
      </div>
    </div>
  );
}

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
  const streamedChars = JSON.stringify(progress?.entry ?? null).length;
  const stop = useStopConversation();

  const [pick, setPick] = useState<ConversationMode>("assistant");

  const messages = roomQ.data?.messages ?? NONE;
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
  const onOpened = (id: string) => {
    setActiveId(id);
    onConversationActive?.(id);
  };
  const snapshot = () => pageRef.current;
  const { outbox, enqueue: handleSend, retry, busy } = useOutbox({ resolvedId, projectId, ecosystemId, onOpened, messages, settled, pick, snapshot });
  const streaming = busy || progress != null;

  const { stage, doing } = turnNow(progress, streaming, t);
  const acts = useActOffers({ messages, progress });
  const { cardsFor } = ui;
  const { offersFor } = acts;
  const afterEntry = (entryId: string) => {
    const cards = cardsFor(entryId);
    const offers = offersFor(entryId);
    return cards || offers ? (
      <>
        {cards}
        {offers}
      </>
    ) : null;
  };

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

  if (resolvedId && outbox.length === 0 && (roomQ.isLoading || roomQ.isError)) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        {roomQ.isError ? <RoomUnreadable error={roomQ.error} onRetry={() => void roomQ.refetch()} /> : <RoomLoading />}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}

      {roomQ.data && <ScopeNotice room={roomQ.data} />}

      <RoomScroll
        scroll={{ scrollRef, bottomRef, onScroll, newOutput, toBottom }}
        empty={messages.length === 0 && outbox.length === 0}
        data={{ projectId, projectSlug: projectRow?.slug, conversationId: resolvedId ?? "", kind: roomQ.data?.kind ?? null, questionnaires: roomQ.data?.questionnaires ?? [] }}
        thread={{ projectId, projectSlug: projectRow?.slug, atBottom, messages, windows: roomQ.data?.windows ?? [], outbox, progress, withdrawn, agentTurns: roomQ.data?.agentTurns ?? [], onRetry: retry, afterEntry }}
        stage={stage ? <TurnStage stage={stage} detail={doing} /> : null}
      />

      <ProposalCards conversationId={resolvedId} threadLength={messages.length} />

      <RoomComposer
        refusal={refusal}
        canWrite={canWrite}
        composer={{
          onSend: handleSend,
          busy,
          queueWhileBusy: true,
          sticky: false,
          attachments: CONVERSATION_ATTACHMENTS,
          placeholder,
          ...(progress && resolvedId ? { onStop: () => stop.mutate(resolvedId), stopping: stop.isPending } : {}),
          ...(initialDraft ? { initialValue: initialDraft } : {}),
          footerControl: (
            <ComposerFooter
              onboarding={onboardingRoom}
              mode={{ value: pick, onChange: setPick, offer: agentOffer, settled: settledMode, disabled: busy }}
              scopeChip={scopeChip}
              sees={page.sees ? { label: page.sees, detail: seesDetail(page.snapshot, { project: projectRow?.name ?? null, scope: ecosystemId ? "ecosystem" : "project" }, t, language) } : null}
            />
          ),
        }}
      />

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
  const [queue, setQueue] = useState<OutboxMessage[]>([]);
  const sendingRef = useRef(false);
  /**
   * What a queued message has already put in storage, kept so a retry after a
   * failed send does not upload the same picture twice and leave the first copy
   * stored and cited by nothing.
   */
  const storedRef = useRef(new Map<string, string[]>());

  // what the server confirmed reads as sent, and leaves once its row is in the thread
  const seen = new Set(messages.map((m) => m.id));
  const outbox = queue.flatMap((m): OutboxMessage[] => {
    const ack = accepted[m.id];
    if (ack && seen.has(ack.messageId)) return [];
    return ack && m.state !== "sent" ? [{ ...m, state: "sent", messageId: ack.messageId }] : [m];
  });

  const enqueue = (message: string, files: File[]) => {
    setQueue((o) => [...o, { id: crypto.randomUUID(), content: message, state: "queued", ...(files.length ? { files } : {}) }]);
    return Promise.resolve();
  };

  const retry = useCallback((id: string) => {
    setQueue((o) => o.map((m) => (m.id === id ? { ...m, state: "queued", error: undefined } : m)));
  }, []);

  useEffect(() => {
    if (sendingRef.current) return;
    if (outbox.some((m) => m.state === "failed")) return;
    const next = outbox.find((m) => m.state === "queued");
    if (!next) return;
    sendingRef.current = true;
    setQueue((o) => o.map((m) => (m.id === next.id ? { ...m, state: "sending" } : m)));
    void (async () => {
      try {
        let id = resolvedId;
        if (!id) {
          id = (await open.mutateAsync({ projectId, ecosystemId: ecosystemId ?? null })).id;
          onOpened(id);
        }
        const fresh = !settled && messages.length === 0;
        const attachmentIds = [...(storedRef.current.get(next.id) ?? [])];
        for (const file of (next.files ?? []).slice(attachmentIds.length)) {
          // one operation per queued message and file position: a retry of this message sends the same id
          const operationId = `${next.id}:${attachmentIds.length}`;
          const put = await upload.mutateAsync({ conversationId: id, file, operationId });
          attachmentIds.push(put.id);
          storedRef.current.set(next.id, [...attachmentIds]);
        }
        await send.mutateAsync({
          conversationId: id,
          content: next.content,
          ...(fresh ? { mode: pick } : {}),
          clientToken: next.id,
          ...(attachmentIds.length ? { attachmentIds } : {}),
          ...(snapshot().sees ? { uiSnapshot: snapshot().snapshot } : {}),
        });
        storedRef.current.delete(next.id);
        setQueue((o) => o.filter((m) => m.id !== next.id));
      } catch (err) {
        setQueue((o) =>
          o.map((m) =>
            m.id === next.id ? { ...m, state: "failed", error: formatApiError(err) } : m,
          ),
        );
      } finally {
        sendingRef.current = false;
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
