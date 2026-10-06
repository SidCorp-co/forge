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

import { type ComponentProps, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EmptyState,
  ErrorState,
  IconButton,
  ProjectLoader,
} from "@/design";
import { ThreadDataProvider } from "@/features/onboarding/components/thread-blocks";
import { ThreadSub } from "@/features/onboarding/components/thread-sub";
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
import { type ConversationMode, type OutboxMessage, conversationTitle } from "../types";
import { ConversationModeControl, modePlaceholder } from "./mode-control";
import { ConversationMembers } from "./conversation-members";
import { ConversationThread } from "./conversation-thread";
import { ScopeNotice } from "./scope-notice";
import { seesDetail, useUiActions, useUiSnapshot } from "../ui-actions/use-ui-actions";

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
  const [activeId, setActiveId] = useState<string | undefined>(conversationId);
  const [membersOpen, setMembersOpen] = useState(false);
  const resolvedId = conversationId ?? activeId;

  const projectRow = useProjects().data?.find((p) => p.id === projectId);
  const canWrite = canWriteProject(projectRow?.role);

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
  const settledMode: ConversationMode | null = settled ? (roomQ.data?.mode ?? "assistant") : null;
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
          ...(pageRef.current.sees ? { uiSnapshot: pageRef.current.snapshot } : {}),
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
    onConversationActive,
    ecosystemId,
    settled,
    messages.length,
    pick,
  ]);

  const onboardingRoom = roomQ.data?.kind === "onboarding";
  const header = (
    <header className="@container flex-none border-b border-line bg-app/95 px-3 py-2 @2xl:px-4 @2xl:py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13.5px] font-bold leading-snug text-fg @2xl:text-[22px] @2xl:leading-tight">
            {roomQ.data ? conversationTitle(roomQ.data, messages[0]?.content) : "New conversation"}
          </h2>
          <ThreadSub kind={roomQ.data?.kind} status={roomQ.data?.threadStatus} projectId={projectId} />
        </div>
        {roomQ.data && (
          <IconButton
            icon="users"
            size="sm"
            aria-label="Who is in this room"
            onClick={() => setMembersOpen(true)}
          />
        )}
        {headerActions}
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

      <div ref={scrollRef} onScroll={onScroll} className="@container min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-3 py-3 @2xl:px-8 @2xl:py-8 xl:max-w-4xl">
          {messages.length === 0 && outbox.length === 0 ? (
            <div className="flex min-h-[40dvh] flex-col">
              <div className="grid flex-1 place-items-center">
                <EmptyState
                  title="Start a conversation"
                  message="Ask the agent anything about this project — its issues, its progress and what it knows."
                  mascot
                />
              </div>
            </div>
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
              atBottom={atBottom}
              messages={messages}
              windows={windows}
              outbox={outbox}
              progress={progress}
              withdrawn={withdrawn}
              agentTurns={agentTurns}
              onRetry={retry}
              afterEntry={ui.cardsFor}
            />
            </ThreadDataProvider>
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
          placeholder={onboardingRoom ? ONBOARDING_PLACEHOLDER : modePlaceholder(settledMode ?? pick)}
          {...(progress && resolvedId
            ? { onStop: () => stop.mutate(resolvedId), stopping: stop.isPending }
            : {})}
          {...(initialDraft ? { initialValue: initialDraft } : {})}
          footerControl={
            onboardingRoom ? (
              <span className="fg-caption text-subtle" data-testid="composer-to-onboarding-job">
                To the onboarding job, which drafts the designs
              </span>
            ) : (
              <ModeFooter
                mode={{ value: pick, onChange: setPick, offer: agentOffer, settled: settledMode, disabled: busy }}
                scopeChip={scopeChip}
                sees={page.sees ? { label: page.sees, detail: seesDetail(page.snapshot, { project: projectRow?.name ?? null, scope: ecosystemId ? "ecosystem" : "project" }) } : null}
              />
            )
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

const ONBOARDING_PLACEHOLDER = "Message the onboarding job — it reads every message here before it asks you anything…";

/** The composer's footer in a chat with a mode: the mode, the room's scope, and what the agent sees. */
function ModeFooter({
  mode,
  scopeChip,
  sees,
}: {
  mode: ComponentProps<typeof ConversationModeControl>;
  scopeChip: ReactNode;
  sees: { label: string; detail: string } | null;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <ConversationModeControl {...mode} />
      {scopeChip}
      {sees && (
        <span
          data-testid="composer-sees"
          title={sees.detail}
          className="fg-caption inline-flex max-w-[16rem] items-center gap-1 truncate text-subtle"
        >
          Sees {sees.label}
        </span>
      )}
    </div>
  );
}
