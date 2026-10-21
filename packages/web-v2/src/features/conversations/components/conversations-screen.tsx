"use client";


import { useCallback, useMemo, useRef, useState } from "react";
import {
  ConfirmDialog,
  IconButton,
  PageTitle,
  SlideOver,
  useMediaQuery,
} from "@/design";
import { useActiveOrg } from "@/features/orgs/active-org";
import { useOrgScopedProjects, useProjects } from "@/features/projects/hooks";
import { usePersistedState } from "@/lib/utils/use-persisted-state";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import {
  type ListedConversation,
  useArchiveConversation,
  useConversationsAcrossProjects,
  useDeleteConversation,
  useRenameConversation,
} from "../hooks";
import { conversationTitle, type RoomWithoutAProject } from "../types";
import { ConversationChat } from "./conversation-chat";
import { ConversationSidebar } from "./conversation-sidebar";
import { OrphanRoomView } from "./orphan-room-view";
import { type OrphanFacts, RoomsWithoutAProject } from "./orphan-rooms";
import { StartConversation } from "./start-conversation";

const SIDEBAR_COLLAPSED_KEY = "web-v2:conversations-sidebar-collapsed";

interface Selection {
  /** Bumped only on a user-initiated pick — remounts the chat. NOT bumped when a
   *  draft's first send resolves to a real conversation, so that transition stays
   *  in one mount (no visible restart). */
  key: number;
  projectId: string;
  /** `null` = a fresh draft in `projectId`, which opens its room on the first send. */
  conversationId: string | null;
}

/** Zero-render WS room subscription, so a reply anywhere shows up live. */
function RoomSub({ projectId }: { projectId: string }) {
  useRoom(projectRoom(projectId));
  return null;
}

export function ConversationsScreen() {
  const projectsQ = useProjects();
  const { projects: orgProjects, projectIds: orgProjectIds } = useOrgScopedProjects();
  const projectIdList = useMemo(() => [...orgProjectIds].sort(), [orgProjectIds]);
  const [showArchived, setShowArchived] = useState(false);
  const { activeOrgId } = useActiveOrg();
  const conversations = useConversationsAcrossProjects(projectIdList, showArchived);

  const [selection, setSelection] = useState<Selection | null>(null);
  /** A room whose project was deleted, opened read-only in place of a chat (ISS-1229 r24). */
  const [orphan, setOrphan] = useState<{ room: RoomWithoutAProject; facts: OrphanFacts } | null>(null);
  const selectionKeyRef = useRef(0);
  const [collapsed, setCollapsed] = usePersistedState<boolean>(SIDEBAR_COLLAPSED_KEY, false, {
    syncTabs: false,
  });
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const wide = useMediaQuery("(min-width: 768px)");
  const [confirming, setConfirming] = useState<ListedConversation | null>(null);

  const rename = useRenameConversation();
  const archive = useArchiveConversation();
  const remove = useDeleteConversation();

  const nameById = useMemo(() => {
    const m = new Map<string, { name: string; slug: string }>();
    for (const p of projectsQ.data ?? []) m.set(p.id, { name: p.name, slug: p.slug });
    return m;
  }, [projectsQ.data]);

  const now = Date.now();

  const openRow = useCallback((row: ListedConversation) => {
    setOrphan(null);
    selectionKeyRef.current += 1;
    setSelection({ key: selectionKeyRef.current, projectId: row.projectId, conversationId: row.id });
    setMobileHistoryOpen(false);
  }, []);

  const startNew = useCallback(() => {
    setOrphan(null);
    setSelection(null);
    setMobileHistoryOpen(false);
  }, []);

  const dropIfOpen = useCallback((conversationId: string) => {
    setSelection((s) => (s?.conversationId === conversationId ? null : s));
  }, []);

  const openStarted = useCallback((conversationId: string, projectId: string) => {
    setOrphan(null);
    selectionKeyRef.current += 1;
    setSelection({ key: selectionKeyRef.current, projectId, conversationId });
  }, []);

  const sidebar = (inDrawer: boolean) => (
    <ConversationSidebar
      rows={conversations.rows}
      nameById={nameById}
      now={now}
      activeConversationId={selection?.conversationId ?? undefined}
      collapsed={inDrawer ? false : collapsed}
      onToggleCollapse={inDrawer ? () => setMobileHistoryOpen(false) : () => setCollapsed((c) => !c)}
      {...(inDrawer ? { onClose: () => setMobileHistoryOpen(false) } : {})}
      onNew={startNew}
      onOpen={openRow}
      showArchived={showArchived}
      onToggleArchived={() => setShowArchived((v) => !v)}
      onRename={(title, row) => rename.mutate({ id: row.id, title })}
      onArchive={(archived, row) => {
        archive.mutate({ id: row.id, archived }, { onSuccess: () => dropIfOpen(row.id) });
      }}
      onDelete={(row) => setConfirming(row)}
      below={
        showArchived ? null : (
          <RoomsWithoutAProject
            orgId={activeOrgId ?? null}
            openId={orphan?.room.id}
            onDeleted={(id) => setOrphan((o) => (o?.room.id === id ? null : o))}
            onOpen={(room, facts) => {
              setSelection(null);
              setOrphan({ room, facts });
              setMobileHistoryOpen(false);
            }}
          />
        )
      }
      loading={conversations.isLoading}
      error={conversations.error}
      onRetry={conversations.refetch}
    />
  );

  return (
    <div className="flex min-h-dvh flex-col md:h-full md:min-h-0 md:overflow-hidden">
      {orgProjects.map((p) => (
        <RoomSub key={p.id} projectId={p.id} />
      ))}

      <header className="flex flex-none items-center justify-between gap-3 border-b border-line px-4 py-3 md:hidden">
        <PageTitle className="fg-h2">Conversations</PageTitle>
        <IconButton
          icon="clock"
          aria-label="Conversation history"
          onClick={() => setMobileHistoryOpen(true)}
        />
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="hidden md:flex md:min-h-0">{sidebar(false)}</div>

        {/* min-w-0: a long title in the view below is cut to this column, never widens it past the
            screen (ISS-1229 r25, judge-72: 611px wide at 390). */}
        <div className="min-h-0 min-w-0 flex-1 bg-app" data-testid="conversation-main">
          {orphan ? (
            <OrphanRoomView
              key={orphan.room.id}
              room={orphan.room}
              facts={orphan.facts}
              onDeleted={() => setOrphan(null)}
            />
          ) : selection ? (
            <ConversationChat
              key={selection.key}
              projectId={selection.projectId}
              conversationId={selection.conversationId ?? undefined}
              onConversationActive={(id) =>
                setSelection((s) => (s ? { ...s, conversationId: id } : s))
              }
              onRoomGone={(id) => {
                // Back to the room list: the sidebar beside it, or the drawer on a phone (ISS-1229 r28).
                dropIfOpen(id);
                if (!wide) setMobileHistoryOpen(true);
              }}
            />
          ) : (
            <StartConversation onStarted={openStarted} />
          )}
        </div>
      </div>

      <SlideOver
        open={mobileHistoryOpen}
        onClose={() => setMobileHistoryOpen(false)}
        hideHeader
        fitBody
        width="min(85vw, 320px)"
      >
        {sidebar(true)}
      </SlideOver>

      <ConfirmDialog
        open={confirming !== null}
        title="Delete this conversation?"
        message={
          confirming
            ? `“${conversationTitle(confirming)}” and everything said in it will be gone. Archive it instead to keep it out of the way.`
            : ""
        }
        confirmLabel="Delete"
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => {
          if (!confirming) return;
          const id = confirming.id;
          remove.mutate(id, { onSuccess: () => dropIfOpen(id) });
          setConfirming(null);
        }}
        onClose={() => setConfirming(null)}
      />
    </div>
  );
}
