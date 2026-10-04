"use client";

// One conversation, open: its thread, and the box you type in. A conversation is an append-only
// log, so the run-shaped verbs (model and runner pick, fork, rerun, edit, regenerate) stay on the
// session surface.

import { useMemo, useState } from "react";
import { ErrorState, IconButton, ProjectLoader } from "@/design";
import { ThreadDataProvider } from "@/features/onboarding/components/thread-blocks";
import { ThreadSub } from "@/features/onboarding/components/thread-sub";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { useAcceptedMessages, useConversation, useConversationProgress, useWithdrawnDrafts } from "../hooks";
import { type ConversationDetail, type ConversationMode, conversationTitle } from "../types";
import { useUiActions, useUiSnapshot } from "../ui-actions/use-ui-actions";
import { ConversationComposer } from "./conversation-composer";
import { ConversationMembers } from "./conversation-members";
import { ConversationThread } from "./conversation-thread";
import { RoomScroll } from "./room-scroll";
import { ScopeNotice } from "./scope-notice";
import { useOutbox } from "./use-outbox";

export interface ConversationChatProps {
  projectId: string;
  /** Omitted = a draft: no room exists until the first message opens one. */
  conversationId?: string | undefined;
  /** Fires once a draft's first send has opened a real room, so the caller can follow it. */
  onConversationActive?: (id: string) => void;
  initialDraft?: string;
  ecosystemId?: string | null;
  headerActions?: React.ReactNode;
  scopeChip?: React.ReactNode;
}

export function ConversationChat(props: ConversationChatProps) {
  const { projectId, conversationId, ecosystemId } = props;
  const [activeId, setActiveId] = useState<string | undefined>(conversationId);
  const [pick, setPick] = useState<ConversationMode>("assistant");
  const resolvedId = conversationId ?? activeId;

  const projectRow = useProjects().data?.find((p) => p.id === projectId);
  const roomQ = useConversation(resolvedId);
  const room = roomQ.data;
  const accepted = useAcceptedMessages(resolvedId);
  const progress = useConversationProgress(resolvedId);
  const messages = useMemo(() => room?.messages ?? [], [room]);

  const page = useUiSnapshot(projectRow?.slug);
  const ready = Boolean(projectRow) && (!resolvedId || roomQ.isSuccess);
  const ui = useUiActions({ slug: projectRow?.slug ?? "", ready, messages, progress });

  const settledMode: ConversationMode | null =
    room && (room.mode !== null || messages.length > 0) ? (room.mode ?? "assistant") : null;
  const { outbox, enqueue, retry, busy } = useOutbox({
    projectId,
    ecosystemId: ecosystemId ?? null,
    conversationId: resolvedId,
    onOpened: (id) => {
      setActiveId(id);
      props.onConversationActive?.(id);
    },
    messages,
    accepted,
    settled: settledMode !== null,
    mode: pick,
    page,
  });

  const blocked = resolvedId && outbox.length === 0 && (roomQ.isLoading || roomQ.isError);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <RoomHeader room={room} conversationId={resolvedId} firstSaid={messages[0]?.content} actions={props.headerActions} />
      {blocked ? <RoomUnread query={roomQ} /> : (
        <>
          {room && <ScopeNotice room={room} />}
          <RoomScroll
            conversationKey={resolvedId}
            ready={roomQ.isSuccess}
            itemCount={messages.length + outbox.length}
            busy={busy}
            progress={progress}
          >
            {(atBottom) => (
              <RoomThread
                projectId={projectId}
                conversationId={resolvedId}
                room={room}
                atBottom={atBottom}
                messages={messages}
                outbox={outbox}
                progress={progress}
                onRetry={retry}
                afterEntry={ui.cardsFor}
              />
            )}
          </RoomScroll>
          <ConversationComposer
            room={room}
            projectId={projectId}
            conversationId={resolvedId}
            project={projectRow}
            live={progress != null}
            busy={busy}
            onSend={async (message, files) => enqueue(message, files)}
            mode={pick}
            onModeChange={setPick}
            settledMode={settledMode}
            initialDraft={props.initialDraft}
            scopeChip={props.scopeChip}
            page={page}
            scope={ecosystemId ? "ecosystem" : "project"}
          />
        </>
      )}
    </div>
  );
}

type ThreadProps = Parameters<typeof ConversationThread>[0];

function RoomUnread({ query }: { query: ReturnType<typeof useConversation> }) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center px-4 py-12">
      {query.isLoading ? (
        <ProjectLoader label="loading conversation…" />
      ) : (
        <ErrorState
          title="Couldn't load this conversation"
          message={formatApiError(query.error)}
          onRetry={() => query.refetch()}
        />
      )}
    </div>
  );
}

function RoomThread({
  projectId,
  conversationId,
  room,
  ...thread
}: {
  projectId: string;
  conversationId: string | undefined;
  room: ConversationDetail | undefined;
} & Pick<ThreadProps, "atBottom" | "messages" | "outbox" | "progress" | "onRetry" | "afterEntry">) {
  const withdrawn = useWithdrawnDrafts(conversationId);
  return (
    <ThreadDataProvider
      value={{
        projectId,
        conversationId: conversationId ?? "",
        kind: room?.kind ?? null,
        questionnaires: room?.questionnaires ?? [],
      }}
    >
      <ConversationThread
        {...thread}
        windows={room?.windows ?? []}
        withdrawn={withdrawn}
        agentTurns={room?.agentTurns ?? []}
      />
    </ThreadDataProvider>
  );
}

function RoomHeader({
  room,
  conversationId,
  firstSaid,
  actions,
}: {
  room: ConversationDetail | undefined;
  conversationId: string | undefined;
  firstSaid: string | undefined;
  actions: React.ReactNode;
}) {
  const [membersOpen, setMembersOpen] = useState(false);
  return (
    <header className="@container flex-none border-b border-line bg-app/95 px-3 py-2 @2xl:px-4 @2xl:py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13.5px] font-bold leading-snug text-fg @2xl:text-[22px] @2xl:leading-tight">
            {room ? conversationTitle(room, firstSaid) : "New conversation"}
          </h2>
          <ThreadSub kind={room?.kind} status={room?.threadStatus} />
        </div>
        {room && <IconButton icon="users" size="sm" aria-label="Who is in this room" onClick={() => setMembersOpen(true)} />}
        {actions}
      </div>
      {room?.participants && conversationId && (
        <ConversationMembers
          conversationId={conversationId}
          room={room}
          canChange={room.canChangeMembership === true}
          open={membersOpen}
          onClose={() => setMembersOpen(false)}
        />
      )}
    </header>
  );
}
