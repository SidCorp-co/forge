"use client";

// web-v2 workspace surface: Conversations (ISS-668, redesigned ISS-729, ported
// to the conversation store at ISS-1004 step 5). Exactly ONE open conversation
// at a time, full-width, with a collapsible left history sidebar.
//
// What changed at the port is what it reads: the sidebar and the centre pane are
// `/api/conversations` rows now, not `agent_sessions` rows. The owner-privacy
// filter this screen used to need — `metadataType:"agent"`, which is what
// triggered the server's ISS-522 `eq(userId)` scoping — is gone, because the
// conversation routes refuse a one-to-one room to anybody who is not in it
// rather than relying on a query parameter being passed.

import { useCallback, useMemo, useRef, useState } from "react";
import { ConfirmDialog, IconButton, SlideOver } from "@/design";
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
import { conversationTitle } from "../types";
import { ConversationChat } from "./conversation-chat";
import { ConversationSidebar } from "./conversation-sidebar";
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
  const conversations = useConversationsAcrossProjects(projectIdList);

  const [selection, setSelection] = useState<Selection | null>(null);
  const selectionKeyRef = useRef(0);
  const [collapsed, setCollapsed] = usePersistedState<boolean>(SIDEBAR_COLLAPSED_KEY, false, {
    syncTabs: false,
  });
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
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
    selectionKeyRef.current += 1;
    setSelection({ key: selectionKeyRef.current, projectId: row.projectId, conversationId: row.id });
    setMobileHistoryOpen(false);
  }, []);

  // cm:guard "New conversation" clears the selection and never auto-picks the last project: picking one for somebody sends their next message into a project they did not choose
  const startNew = useCallback(() => {
    setSelection(null);
    setMobileHistoryOpen(false);
  }, []);

  // cm:guard a room archived or deleted while it is the OPEN one clears the selection, so the
  // centre pane never holds a thread this screen's own sidebar no longer lists (ISS-1028).
  const dropIfOpen = useCallback((conversationId: string) => {
    setSelection((s) => (s?.conversationId === conversationId ? null : s));
  }, []);

  // cm:guard the room is opened by the START step and arrives here already holding its members, so the selection carries a real conversation id rather than a draft: a room started with a colleague and a second agent has to exist before either can be put in it, and a draft that opens on the first send has nowhere to put them (ISS-1011 criterion 39).
  const openStarted = useCallback((conversationId: string, projectId: string) => {
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
      onRename={(title, row) => rename.mutate({ id: row.id, title })}
      onArchive={(archived, row) => {
        archive.mutate({ id: row.id, archived });
        dropIfOpen(row.id);
      }}
      onDelete={(row) => setConfirming(row)}
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
        <h1 className="fg-h2">Conversations</h1>
        <IconButton
          icon="clock"
          aria-label="Conversation history"
          onClick={() => setMobileHistoryOpen(true)}
        />
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="hidden md:flex md:min-h-0">{sidebar(false)}</div>

        <div className="min-h-0 flex-1 bg-app">
          {selection ? (
            <ConversationChat
              key={selection.key}
              projectId={selection.projectId}
              conversationId={selection.conversationId ?? undefined}
              onConversationActive={(id) =>
                setSelection((s) => (s ? { ...s, conversationId: id } : s))
              }
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
          remove.mutate(confirming.id);
          dropIfOpen(confirming.id);
          setConfirming(null);
        }}
        onClose={() => setConfirming(null)}
      />
    </div>
  );
}
