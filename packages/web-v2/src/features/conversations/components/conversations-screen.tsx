"use client";

// web-v2 workspace surface: Conversations (ISS-668, redesigned ISS-729).
// ChatGPT/Claude/Gemini model — exactly ONE active chat at a time, full-width,
// with a collapsible left history sidebar. Replaces the ISS-689 multi-pane
// split-view: the center chat is rendered by the existing `ChatScreen` (not
// `SessionScreen`) since it already handles draft→create-on-send in one mount
// (no restart) and already gates auto-scroll on `turnsQ.isSuccess` (no folded-
// in race). This screen owns selection + the sidebar; ChatScreen stays the
// single source of chat rendering shared with `/projects/[slug]/agent`.
import { useCallback, useMemo, useRef, useState } from "react";
import { IconButton, Select, SlideOver } from "@/design";
import { useOrgScopedProjects, useProjects } from "@/features/projects/hooks";
import { useSessions } from "@/features/sessions/hooks";
import { isInteractiveSession, type SessionRow } from "@/features/sessions/types";
import { ChatScreen } from "@/features/session/components/chat-screen";
import { usePersistedState } from "@/lib/utils/use-persisted-state";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { ConversationSidebar } from "./conversation-sidebar";

const SIDEBAR_COLLAPSED_KEY = "web-v2:conversations-sidebar-collapsed";

interface Selection {
  /** Bumped only on a user-initiated pick (row click, or project pick for
   *  New) — remounts ChatScreen. NOT bumped when a draft's first send
   *  resolves to a real session id, so that transition stays in one mount
   *  (no visible restart). */
  key: number;
  projectId: string;
  /** `null` = fresh draft in `projectId`; set once the draft's first send
   *  creates a real session (via `onSessionActive`), or immediately when an
   *  existing conversation is opened from the sidebar. */
  sessionId: string | null;
}

/** Zero-render WS room subscription — fans the list out across every visible
 *  (org-scoped) project so a reply anywhere shows up live (mirrors the
 *  Sessions workspace tier's RoomSub pattern). */
function RoomSub({ projectId }: { projectId: string }) {
  useRoom(projectRoom(projectId));
  return null;
}

/** Center-area "start a conversation" prompt. The New-conversation flow lands
 *  here inline in the main area (no SlideOver, no restart, ISS-729 AC): pick a
 *  project, then the center mounts a draft ChatScreen that creates the session
 *  on first send. */
function NewConversationPrompt({ onPick }: { onPick: (projectId: string) => void }) {
  const { projects } = useOrgScopedProjects();
  const options = projects.map((p) => ({ value: p.id, label: p.name }));

  return (
    <div className="grid h-full min-h-0 place-items-center px-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <div>
          <p className="fg-h3">Start a conversation</p>
          <p className="fg-body-sm mt-1 text-muted">
            Pick a project to start chatting with its agent.
          </p>
        </div>
        <div className="w-full text-left">
          <label htmlFor="conversations-new-project" className="fg-body-sm mb-1.5 block text-muted">
            Project
          </label>
          <Select
            id="conversations-new-project"
            options={options}
            value=""
            onChange={onPick}
            placeholder="Select a project…"
          />
        </div>
      </div>
    </div>
  );
}

export function ConversationsScreen() {
  // metadataType:"agent" is REQUIRED here — it's what triggers the server's
  // ISS-522 owner-privacy scoping (eq userId) on the cross-project branch.
  // Without it, other org members' interactive chats (title, id, status,
  // cost) leak into this caller-visible-projects listing.
  const sessionsQ = useSessions({ metadataType: "agent" });
  const projectsQ = useProjects();
  const { projects: orgProjects, projectIds: orgProjectIds } = useOrgScopedProjects();

  const [selection, setSelection] = useState<Selection | null>(null);
  const selectionKeyRef = useRef(0);
  const [collapsed, setCollapsed] = usePersistedState<boolean>(SIDEBAR_COLLAPSED_KEY, false, {
    syncTabs: false,
  });
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);

  const nameById = useMemo(() => {
    const m = new Map<string, { name: string; slug: string }>();
    for (const p of projectsQ.data ?? []) m.set(p.id, { name: p.name, slug: p.slug });
    return m;
  }, [projectsQ.data]);

  // Hard org scope + structural chat-only filter — pipeline/pm rows never
  // reach this surface, not just hidden by a client-side toggle (AC1).
  const rows = useMemo(() => {
    const all = sessionsQ.data?.items ?? [];
    return all.filter((r) => isInteractiveSession(r) && orgProjectIds.has(r.projectId));
  }, [sessionsQ.data, orgProjectIds]);

  const now = Date.now();

  const openRow = useCallback((row: SessionRow) => {
    selectionKeyRef.current += 1;
    setSelection({ key: selectionKeyRef.current, projectId: row.projectId, sessionId: row.id });
    setMobileHistoryOpen(false);
  }, []);

  // "New conversation" never auto-picks the last project (owner decision) — it
  // clears the active chat and returns to the inline project-picker prompt.
  const startNew = useCallback(() => {
    setSelection(null);
    setMobileHistoryOpen(false);
  }, []);

  const pickProjectForNew = useCallback((projectId: string) => {
    selectionKeyRef.current += 1;
    setSelection({ key: selectionKeyRef.current, projectId, sessionId: null });
  }, []);

  return (
    <div className="flex min-h-dvh flex-col md:h-full md:min-h-0 md:overflow-hidden">
      {orgProjects.map((p) => (
        <RoomSub key={p.id} projectId={p.id} />
      ))}

      <header className="flex flex-none items-center justify-between gap-3 border-b border-line px-4 py-3 md:hidden">
        <h1 className="fg-h2">Conversations</h1>
        <IconButton icon="clock" aria-label="Conversation history" onClick={() => setMobileHistoryOpen(true)} />
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="hidden md:flex md:min-h-0">
          <ConversationSidebar
            rows={rows}
            nameById={nameById}
            now={now}
            activeSessionId={selection?.sessionId ?? undefined}
            collapsed={collapsed}
            onToggleCollapse={() => setCollapsed((c) => !c)}
            onNew={startNew}
            onOpen={openRow}
            loading={sessionsQ.isLoading}
            error={sessionsQ.isError ? sessionsQ.error : null}
            onRetry={() => sessionsQ.refetch()}
          />
        </div>

        <div className="min-h-0 flex-1 bg-app">
          {selection ? (
            <ChatScreen
              key={selection.key}
              projectId={selection.projectId}
              activeSessionId={selection.sessionId ?? undefined}
              initialDraft={selection.sessionId === null}
              hideHistory
              onSessionActive={(id) => setSelection((s) => (s ? { ...s, sessionId: id } : s))}
            />
          ) : (
            <NewConversationPrompt onPick={pickProjectForNew} />
          )}
        </div>
      </div>

      {/* Mobile: history sidebar in a drawer — its own header (New + Close)
          replaces the SlideOver's default title bar (ISS-506 pattern). */}
      <SlideOver
        open={mobileHistoryOpen}
        onClose={() => setMobileHistoryOpen(false)}
        hideHeader
        fitBody
        width="min(85vw, 320px)"
      >
        <ConversationSidebar
          rows={rows}
          nameById={nameById}
          now={now}
          activeSessionId={selection?.sessionId ?? undefined}
          collapsed={false}
          onToggleCollapse={() => setMobileHistoryOpen(false)}
          onClose={() => setMobileHistoryOpen(false)}
          onNew={startNew}
          onOpen={openRow}
          loading={sessionsQ.isLoading}
          error={sessionsQ.isError ? sessionsQ.error : null}
          onRetry={() => sessionsQ.refetch()}
        />
      </SlideOver>
    </div>
  );
}
