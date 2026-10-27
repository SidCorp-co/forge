"use client";


import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  IconButton,
  PageTitle,
  ProjectLoader,
  SlideOver,
  useMediaQuery,
} from "@/design";
import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { useActiveOrg } from "@/features/orgs/active-org";
import { useOrgScopedProjects, useProjects } from "@/features/projects/hooks";
import { usePersistedState } from "@/lib/utils/use-persisted-state";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import {
  type ListedConversation,
  useArchiveConversation,
  useConversation,
  useConversationsAcrossProjects,
  useDeleteConversation,
  useRenameConversation,
} from "../hooks";
import { STEPS_ASIDE } from "../composing";
import { changesRoom, NO_ACCESS_TITLE, refusedForScope, startsRooms } from "../membership";
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
  archived: boolean;
}

/**
 * The room the address names, and whether it is archived, so its list is the one shown: a reload
 * returns to the room that was open (ISS-1229 r35, judge-95).
 */
function addressedRoom(): { room: string | null; archived: boolean } {
  if (typeof window === "undefined") return { room: null, archived: false };
  const search = new URLSearchParams(window.location.search);
  return { room: search.get("room"), archived: search.get("archived") === "1" };
}

/** Name the open room in the address, replacing this entry, so Back is not one step per room opened. */
function addressRoom(room: string | null, archived: boolean) {
  if (typeof window === "undefined") return;
  const search = new URLSearchParams(window.location.search);
  if (room) search.set("room", room);
  else search.delete("room");
  if (room && archived) search.set("archived", "1");
  else search.delete("archived");
  const qs = search.toString();
  const next = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
  // `null` state: Next skips syncing its search params for a state carrying its own mark.
  if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", next);
}

/** A read of a room refused as gone, or as a one-to-one room the reader is not in: the address names no room they can open. */
function notTheirs(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || (err.status === 403 && err.code === "NOT_IN_THE_ROOM"));
}

const roomId = z.uuid();

/** An id core's room door takes: a link cut short or mistyped names no room, and is never read (ISS-1229 r46). */
function namesARoom(id: string): boolean {
  return roomId.safeParse(id).success;
}

/** Zero-render WS room subscription, so a reply anywhere shows up live. */
function RoomSub({ projectId }: { projectId: string }) {
  useRoom(projectRoom(projectId));
  return null;
}

export function ConversationsScreen() {
  const projectsQ = useProjects();
  const {
    projects: orgProjects,
    projectIds: orgProjectIds,
    isLoading: orgLoading,
    error: projectsUnread,
    refetch: readProjects,
  } = useOrgScopedProjects();
  const projectIdList = useMemo(() => [...orgProjectIds].sort(), [orgProjectIds]);
  const addressed = useRef(addressedRoom());
  const [showArchived, setShowArchived] = useState(addressed.current.archived);
  const { activeOrgId, orgs } = useActiveOrg();
  const conversations = useConversationsAcrossProjects(projectIdList, showArchived);

  const [selection, setSelection] = useState<Selection | null>(null);
  /** A room whose project was deleted, opened read-only in place of a chat (ISS-1229 r24). */
  const [orphan, setOrphan] = useState<{ room: RoomWithoutAProject; facts: OrphanFacts } | null>(null);
  const [lookup, setLookupState] = useState<string | null>(null);
  // Read in the same commit the lookup starts in, before its state lands, so the address keeps the id.
  const lookupRef = useRef<string | null>(null);
  const setLookup = useCallback((room: string | null) => {
    lookupRef.current = room;
    setLookupState(room);
  }, []);
  const malformed = lookup !== null && !namesARoom(lookup);
  const roomRead = useConversation(lookup && !malformed ? lookup : undefined);
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
  // A reader who only views every project here is offered no room to start (ISS-1229 r35, judge-95).
  const startsNone = orgLoading || !orgProjects.some((p) => startsRooms(p.role));

  const openRow = useCallback((row: ListedConversation) => {
    setOrphan(null);
    setLookup(null);
    selectionKeyRef.current += 1;
    setSelection({
      key: selectionKeyRef.current,
      projectId: row.projectId,
      conversationId: row.id,
      archived: row.archivedAt !== null,
    });
    setMobileHistoryOpen(false);
  }, [setLookup]);

  const startNew = useCallback(() => {
    setOrphan(null);
    setLookup(null);
    setSelection(null);
    setMobileHistoryOpen(false);
  }, [setLookup]);

  const dropIfOpen = useCallback((conversationId: string) => {
    setSelection((s) => (s?.conversationId === conversationId ? null : s));
  }, []);

  const openStarted = useCallback((conversationId: string, projectId: string) => {
    setOrphan(null);
    setLookup(null);
    selectionKeyRef.current += 1;
    setSelection({ key: selectionKeyRef.current, projectId, conversationId, archived: false });
  }, [setLookup]);

  // Lists are capped, so only the room's own read can say it is gone (ISS-1229 r45, judge-129).
  useEffect(() => {
    const room = addressed.current.room;
    // Until the projects are read there is no list to find it in, only an empty one.
    if (!room || projectsQ.isLoading || orgLoading || conversations.isLoading) return;
    addressed.current = { room: null, archived: false };
    const row = conversations.rows.find((r) => r.id === room);
    if (row) openRow(row);
    else setLookup(room);
  }, [projectsQ.isLoading, orgLoading, conversations.isLoading, conversations.rows, openRow, setLookup]);

  const read = lookup ? roomRead.data : undefined;
  const readProject = read ? (read.scope.find((id) => orgProjectIds.has(id)) ?? read.scope[0]) : undefined;
  useEffect(() => {
    if (!lookup || !read) return;
    // A room about no project is listed under Project deleted, which only the live list shows.
    if (!readProject) {
      setShowArchived(false);
      return;
    }
    const archived = read.archivedAt !== null;
    setShowArchived(archived);
    selectionKeyRef.current += 1;
    setSelection({ key: selectionKeyRef.current, projectId: readProject, conversationId: lookup, archived });
    setLookup(null);
  }, [lookup, read, readProject, setLookup]);

  const openRoomId = selection?.conversationId ?? null;
  // The open room is in an organization this list does not show: the list says so, never that there is none.
  const openProjectOrg = selection ? projectsQ.data?.find((p) => p.id === selection.projectId)?.orgId : undefined;
  const openElsewhere =
    openRoomId && !conversations.isLoading && !conversations.rows.some((r) => r.id === openRoomId) && openProjectOrg !== activeOrgId
      ? {
          roomOrg: orgs.find((o) => o.id === openProjectOrg)?.name ?? null,
          listOrg: orgs.find((o) => o.id === activeOrgId)?.name ?? null,
        }
      : null;
  const openArchived = selection?.archived === true;
  useEffect(() => {
    if (addressed.current.room || lookup || lookupRef.current) return;
    addressRoom(openRoomId, openArchived);
  }, [openRoomId, openArchived, lookup]);

  const sidebar = (inDrawer: boolean) => (
    <ConversationSidebar
      rows={conversations.rows}
      nameById={nameById}
      now={now}
      activeConversationId={selection?.conversationId ?? undefined}
      collapsed={inDrawer ? false : collapsed}
      onToggleCollapse={inDrawer ? () => setMobileHistoryOpen(false) : () => setCollapsed((c) => !c)}
      {...(inDrawer ? { onClose: () => setMobileHistoryOpen(false) } : {})}
      {...(startsNone ? {} : { onNew: startNew })}
      onOpen={openRow}
      showArchived={showArchived}
      onToggleArchived={() => setShowArchived((v) => !v)}
      onRename={(title, row) => rename.mutate({ id: row.id, title })}
      onArchive={(archived, row) => {
        archive.mutate({ id: row.id, archived }, { onSuccess: () => dropIfOpen(row.id) });
      }}
      onDelete={(row) => setConfirming(row)}
      mayChange={(row) => changesRoom(row, (id) => projectsQ.data?.find((p) => p.id === id)?.role)}
      openElsewhere={openElsewhere}
      below={
        showArchived ? null : (
          <RoomsWithoutAProject
            orgId={activeOrgId ?? null}
            openId={orphan?.room.id}
            onDeleted={(id) => setOrphan((o) => (o?.room.id === id ? null : o))}
            onOpen={(room, facts) => {
              setSelection(null);
              setLookup(null);
              setOrphan({ room, facts });
              setMobileHistoryOpen(false);
            }}
          />
        )
      }
      loading={conversations.isLoading}
      // With no projects read there is no list to show, only an empty one (ISS-1229 r47, judge-137).
      error={projectsUnread ?? conversations.error}
      errorTitle={projectsUnread ? "Couldn't load your projects" : "Couldn't load conversations"}
      onRetry={projectsUnread ? readProjects : conversations.refetch}
    />
  );

  // As tall as the frame's main at every width, whose content box ends above a phone's tab bar: a
  // full-screen floor below md put a room's message box under that bar (ISS-1229 r31, judge-88).
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="conversations-screen">
      {orgProjects.map((p) => (
        <RoomSub key={p.id} projectId={p.id} />
      ))}

      <header
        className="flex flex-none items-center justify-between gap-3 border-b border-line px-4 py-3 md:hidden"
        {...STEPS_ASIDE}
      >
        {/* The pane heads the page in every state, at every width: this bar is not there on a desk (ISS-1229 r47). */}
        <PageTitle className="fg-h2" heads={false}>
          Conversations
        </PageTitle>
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
              namesTab
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
          ) : lookup ? (
            <AddressedRoom
              missing={malformed}
              error={roomRead.error}
              read={read !== undefined}
              startsNone={startsNone}
              onRetry={() => void roomRead.refetch()}
            />
          ) : (
            <StartConversation onStarted={openStarted} />
          )}
        </div>
      </div>

      <SlideOver
        open={mobileHistoryOpen}
        onClose={() => setMobileHistoryOpen(false)}
        title="Conversation history"
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

/** The room pane while that read is out, and what it said. */
function AddressedRoom({
  missing,
  error,
  read,
  startsNone,
  onRetry,
}: {
  /** The address cannot name a room at all. */
  missing: boolean;
  error: unknown;
  read: boolean;
  startsNone: boolean;
  onRetry: () => void;
}) {
  const pane = (state: ReactNode) => <div className="grid h-full place-items-center">{state}</div>;
  if (missing || notTheirs(error)) {
    return pane(
      <ErrorState
        level={1}
        title="Conversation not found"
        message={`It was deleted, or you are not one of its people. ${startsNone ? "Pick a conversation from the list." : "Pick a conversation from the list, or start one."}`}
        final
      />,
    );
  }
  // Refused for a project role, the room is there: core's sentence says so and who can add them (ISS-1229 r47).
  if (refusedForScope(error)) return pane(<ErrorState level={1} title={NO_ACCESS_TITLE} message={error.message} final />);
  if (error) {
    return pane(<ErrorState level={1} title="Couldn't load this conversation" message={formatApiError(error)} onRetry={onRetry} />);
  }
  if (read) {
    return pane(
      <EmptyState
        level={1}
        title="This conversation is about no project"
        message="Its project was deleted. Open it from Project deleted, under the list of conversations, in the organization it belonged to."
      />,
    );
  }
  return pane(
    <div className="flex flex-col items-center gap-3">
      <PageTitle className="fg-h3">Opening the conversation</PageTitle>
      <ProjectLoader label="loading conversation…" />
    </div>,
  );
}
