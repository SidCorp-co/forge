"use client";

import {
  AgentWorking,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  Menu,
  MonoTag,
  ProjectLoader,
  SlideOver,
  StatusChip,
  useElapsed,
} from "@/design";
import { useProjects } from "@/features/projects/hooks";
import {
  deriveSessionDisplayStatus,
  deriveStage,
  statusToChip,
} from "@/features/sessions/types";
import { buildShareLink, useRecents } from "@/features/shell";
import { formatApiError } from "@/lib/api/error";
import { usePersistedState } from "@/lib/utils/use-persisted-state";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useToast } from "@/providers/toast-provider";
import { useRouter } from "next/navigation";
// Run-conversation orchestrator (ISS-292). Header (id/title/status + Stop /
// Rerun / Fork), two-pane body (thread + context rail), sticky composer.
// Subscribes to the project WS room so persisted-turn invalidations stream the
// caret + live updates (ISS-291 model — no client-side stream reducer).
import { useEffect, useMemo, useState } from "react";
import {
  useCancelSession,
  useEditTurn,
  useForkSession,
  useRegenerateTurn,
  useRerunSession,
  useSendMessage,
  useSession,
  useSessionTurns,
} from "../hooks";
import { deriveAgentTasks, parseMessages, parseTurns } from "../types";
import { Composer, ReadOnlyComposerNote } from "./composer";
import { ContextRail } from "./context-rail";
import { Conversation } from "./conversation";

interface SessionScreenProps {
  sessionId: string;
  /** Back-link target (project sessions index). */
  projectSlug?: string;
  /** Rendered inside a workspace-tier SlideOver panel (ISS-664) rather than as
   *  a full route page: fills the drawer height instead of the viewport, and
   *  defaults the desktop context rail to collapsed (the drawer is narrower
   *  than a full page). Pass `onClose` alongside this to give the header back
   *  button somewhere to go. */
  embedded?: boolean;
  /** Closes the panel. When set, the header back button calls this instead of
   *  navigating — used by the embedded workspace-tier reply panel. */
  onClose?: () => void;
  /** Renders the condensed single-row header used by the desktop conversation
   *  pane strip (ISS-714) instead of the full header — folds the pane's own
   *  project/waiting bar + the full session header into ONE bar. Orthogonal
   *  to `embedded` (the SlideOver reply panel stays on the full header) —
   *  always pass `embedded` too when using this, `paneChrome` only swaps the
   *  header markup. */
  paneChrome?: boolean;
  /** Project label shown in the paneChrome header (mirrors the row/list). */
  projectName?: string;
  /** "Waiting for me" signal (ISS-664) — mirrors the list, paneChrome only. */
  awaiting?: boolean;
}

export function SessionScreen({
  sessionId,
  projectSlug,
  embedded = false,
  onClose,
  paneChrome = false,
  projectName,
  awaiting,
}: SessionScreenProps) {
  const router = useRouter();
  const { toast } = useToast();
  const { push: pushRecent } = useRecents();
  const sessionQ = useSession(sessionId);
  const turnsQ = useSessionTurns(sessionId);
  const [railOpen, setRailOpen] = useState(false);
  // Desktop context-rail collapse (persisted). Below lg the rail is a SlideOver.
  const [persistedRailCollapsed, setPersistedRailCollapsed] = usePersistedState(
    "web-v2:context-rail",
    false,
  );
  // Embedded (workspace-tier panel): default the rail to collapsed — the
  // drawer is narrower than a full page — but keep it toggleable per-open
  // without touching the full-page project preference (ISS-664 plan Q2).
  const [embeddedRailCollapsed, setEmbeddedRailCollapsed] = useState(true);
  const railCollapsed = embedded ? embeddedRailCollapsed : persistedRailCollapsed;
  const setRailCollapsed = embedded ? setEmbeddedRailCollapsed : setPersistedRailCollapsed;
  const goBack = onClose ?? (projectSlug ? () => router.push(`/projects/${projectSlug}/agents`) : undefined);

  const session = sessionQ.data;
  const issueId = session?.metadata?.issueId;

  // Viewer = read-only: hide the composer (the server 403s sends regardless).
  // The session row carries the projectId; until both load we stay writable —
  // this is UX affordance only.
  const projectsQ = useProjects();
  const canWrite =
    !session ||
    projectsQ.data?.find((p) => p.id === session.projectId)?.role !== "viewer";

  // Track this session as recently-viewed (surfaces in the ⌘K Recent group).
  // Skip in embedded mode (ISS-664 plan Q3): a session glanced at inline from
  // the workspace reply panel should not rewrite the owner's last-visited /
  // ⌘K recents state.
  useEffect(() => {
    if (embedded) return;
    if (!session || !projectSlug) return;
    pushRecent({
      kind: "session",
      id: session.id,
      label: session.title ?? `Session ${session.id.slice(0, 8)}`,
      href: `/projects/${projectSlug}/agents/${session.id}`,
      icon: "agent",
    });
  }, [embedded, session?.id, session?.title, projectSlug, pushRecent]);

  function copyLink() {
    if (!projectSlug) return;
    const url = buildShareLink(`/projects/${projectSlug}/agents/${sessionId}`);
    navigator.clipboard?.writeText(url).then(
      () => toast({ title: "Link copied", description: url, tone: "success" }),
      () => toast({ title: "Couldn't copy link", tone: "error" }),
    );
  }
  // Subscribe to the project room once we know the project — the event-router
  // invalidates ['agent-session', id, 'turns'] on turn.* events.
  useRoom(session ? projectRoom(session.projectId) : null);

  // Prefer the per-turn rows (interactive: live caret + edit/regen/fork
  // anchors). Pipeline/CLI-runner sessions have no turn rows yet — fall back to
  // the full canonical transcript returned on the detail row (read-only).
  const items = useMemo(() => {
    const turns = turnsQ.data?.turns ?? [];
    if (turns.length > 0) return parseTurns(turns);
    if (session?.messages?.length) return parseMessages(session.messages);
    return [];
  }, [turnsQ.data, session?.messages]);
  const fromMessages =
    (turnsQ.data?.turns?.length ?? 0) === 0 && items.length > 0;
  // Task-count indicator (ISS-391) — surfaces "this session ran N agents/skills"
  // in the header without opening the context rail. Same derivation the rail uses.
  const taskCount = useMemo(() => deriveAgentTasks(items).length, [items]);

  const send = useSendMessage(sessionId);
  const regenerate = useRegenerateTurn(sessionId);
  const fork = useForkSession(sessionId);
  const editTurn = useEditTurn(sessionId);
  const cancel = useCancelSession(sessionId);
  const rerun = useRerunSession(sessionId);

  const display = session ? deriveSessionDisplayStatus(session) : "queued";
  const live = display === "running" || display === "stalled";
  const startMs = session?.startedAt
    ? new Date(session.startedAt).getTime()
    : undefined;
  const elapsed = useElapsed(startMs, live);

  const lastTurnId = items.length ? items[items.length - 1].turnId : undefined;

  const goToSession = (id: string) =>
    router.push(`/projects/${projectSlug ?? ""}/agents/${id}`);

  const handleFork = (fromTurnId: string) =>
    fork.mutate(
      { fromTurnId },
      { onSuccess: (s) => projectSlug && goToSession(s.id) },
    );

  // Minimal paneChrome header for the loading/error branches below — the
  // full paneChrome header (with title/status/actions) needs `session`,
  // which isn't loaded yet here, but the pane must stay closable by pointer
  // in every state (ISS-689 always-closable-pane; ISS-714 review blocker).
  const paneChromeStub = paneChrome && (
    <header className="flex flex-none items-center gap-1.5 rounded-t-lg border-b border-line bg-app px-2.5 py-1.5">
      <span className="fg-caption min-w-0 flex-1 truncate text-muted">{projectName}</span>
      <IconButton icon="x" size="sm" aria-label="Close pane" className="min-h-11 min-w-11" onClick={onClose} />
    </header>
  );

  if (sessionQ.isLoading) {
    return (
      <div className={`flex flex-col ${embedded ? "h-full min-h-0" : "min-h-dvh"}`}>
        {paneChromeStub}
        <div className="grid flex-1 place-items-center">
          <ProjectLoader label="loading session…" />
        </div>
      </div>
    );
  }

  if (sessionQ.isError || !session) {
    return (
      <div className={`flex flex-col ${embedded ? "h-full min-h-0" : "min-h-dvh"}`}>
        {paneChromeStub}
        <div className="grid flex-1 place-items-center">
          <ErrorState
            title="Couldn't load session"
            message={formatApiError(sessionQ.error)}
            onRetry={() => sessionQ.refetch()}
          />
        </div>
      </div>
    );
  }

  // Overflow menu items shared by both header layouts — the full header
  // exposes Fork/Open runner/Copy link this way already (ISS-351); the
  // condensed paneChrome header additionally folds "Open issue" in here to
  // keep its primary row to Stop/Rerun + one overflow trigger (ISS-714).
  const menuItems = [
    ...(paneChrome && issueId && projectSlug
      ? [
          {
            label: "Open issue",
            icon: "list" as const,
            onSelect: () => router.push(`/projects/${projectSlug}/issues/${issueId}`),
          },
        ]
      : []),
    ...(!fromMessages && lastTurnId
      ? [
          {
            label: "Fork from last turn",
            icon: "fork" as const,
            onSelect: () => handleFork(lastTurnId),
          },
        ]
      : []),
    ...(session.deviceId
      ? [
          {
            label: "Open runner",
            icon: "server" as const,
            onSelect: () => router.push("/runners"),
          },
        ]
      : []),
    {
      label: "Copy link",
      icon: "link" as const,
      onSelect: copyLink,
    },
  ];

  const railToggle = (
    <IconButton
      icon={railCollapsed ? "chevronLeft" : "panelLeft"}
      aria-label={railCollapsed ? "Show context rail" : "Hide context rail"}
      aria-pressed={railCollapsed}
      size={paneChrome ? "sm" : "md"}
      className="hidden min-h-11 min-w-11 lg:inline-flex"
      onClick={() => setRailCollapsed((c) => !c)}
    />
  );

  return (
    <div className={`flex flex-col ${embedded ? "h-full min-h-0" : "min-h-dvh"}`}>
      {/* Header — paneChrome (ISS-714) folds the pane's own project/waiting
          bar + this session header into ONE condensed row for the desktop
          conversation-pane strip; the full-page route and the SlideOver
          reply panel keep the original two-line header below. */}
      {paneChrome ? (
        <header className="flex flex-none items-center gap-1.5 rounded-t-lg border-b border-line bg-app px-2.5 py-1.5">
          <span className="fg-caption min-w-0 max-w-[30%] flex-none truncate text-muted">
            {projectName}
          </span>
          <h1 className="fg-body-sm min-w-0 flex-1 truncate text-fg">{session.title ?? "Session"}</h1>
          {awaiting && <StatusChip status="waiting" domain="session" size="sm" />}
          <StatusChip
            status={statusToChip(display)}
            stage={deriveStage(session.metadata)}
            size="sm"
            domain="session"
          />
          {live ? (
            <IconButton
              icon="stop"
              size="sm"
              variant="ghost"
              aria-label="Stop"
              className="min-h-11 min-w-11"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            />
          ) : (
            <IconButton
              icon="rerun"
              size="sm"
              variant="ghost"
              aria-label="Rerun"
              className="min-h-11 min-w-11"
              disabled={rerun.isPending}
              onClick={() =>
                rerun.mutate(undefined, {
                  onSuccess: (r) => projectSlug && goToSession(r.id),
                })
              }
            />
          )}
          <Menu
            align="right"
            items={menuItems}
            trigger={
              <IconButton icon="more" size="sm" aria-label="Session actions" className="min-h-11 min-w-11" />
            }
          />
          <IconButton
            icon="rows"
            size="sm"
            aria-label="Show context"
            className="min-h-11 min-w-11 lg:hidden"
            onClick={() => setRailOpen(true)}
          />
          {railToggle}
          <IconButton icon="x" size="sm" aria-label="Close pane" className="min-h-11 min-w-11" onClick={onClose} />
        </header>
      ) : (
        <header className="sticky top-0 z-20 border-b border-line bg-app/95 px-4 py-3 backdrop-blur sm:px-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {goBack && (
              <Button
                variant="ghost"
                size="sm"
                icon="arrowRight"
                className="min-h-11 rotate-180"
                aria-label="Back to sessions"
                onClick={goBack}
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="fg-h3 truncate">{session.title ?? "Session"}</h1>
                <MonoTag hue="cobalt">{session.id.slice(0, 8)}</MonoTag>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <StatusChip
                  status={statusToChip(display)}
                  stage={deriveStage(session.metadata)}
                  size="sm"
                  domain="session"
                />
                {taskCount > 0 && (
                  <Badge tone="neutral">
                    {taskCount} {taskCount === 1 ? "task" : "tasks"}
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {live ? (
                <Button
                  variant="danger"
                  size="sm"
                  icon="stop"
                  className="min-h-11"
                  loading={cancel.isPending}
                  onClick={() => cancel.mutate()}
                >
                  Stop
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  icon="rerun"
                  className="min-h-11"
                  loading={rerun.isPending}
                  onClick={() =>
                    rerun.mutate(undefined, {
                      onSuccess: (r) => projectSlug && goToSession(r.id),
                    })
                  }
                >
                  Rerun
                </Button>
              )}
              {issueId && projectSlug && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon="list"
                  className="min-h-11"
                  onClick={() =>
                    router.push(`/projects/${projectSlug}/issues/${issueId}`)
                  }
                >
                  Open issue
                </Button>
              )}
              <Menu
                align="right"
                items={menuItems}
                trigger={
                  <IconButton
                    icon="more"
                    aria-label="Session actions"
                    className="min-h-11 min-w-11"
                  />
                }
              />
              <IconButton
                icon="rows"
                aria-label="Show context"
                className="min-h-11 min-w-11 lg:hidden"
                onClick={() => setRailOpen(true)}
              />
              {railToggle}
            </div>
          </div>
        </header>
      )}

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 xl:max-w-5xl">
              {turnsQ.isLoading ? (
                <ProjectLoader label="loading turns…" size={110} />
              ) : items.length === 0 ? (
                <EmptyState
                  title="No messages yet"
                  message={
                    live
                      ? "The agent is starting up…"
                      : "This session has no turns."
                  }
                />
              ) : (
                <Conversation
                  items={items}
                  streaming={live && !fromMessages}
                  readOnly={fromMessages}
                  busy={
                    live ||
                    send.isPending ||
                    regenerate.isPending ||
                    editTurn.isPending
                  }
                  onRegenerate={(turnId) => regenerate.mutate(turnId)}
                  onFork={handleFork}
                  onEditTurn={(turnId, content, expectedEditedAt) =>
                    editTurn.mutate({ turnId, content, expectedEditedAt })
                  }
                />
              )}
              {live && (
                <div className="mt-5">
                  <AgentWorking label="Agent is working…" elapsed={elapsed} />
                </div>
              )}
            </div>
          </div>
          {canWrite ? (
            <Composer
              onSend={async (message) => {
                await send.mutateAsync({ sessionId, message });
              }}
              busy={live || send.isPending}
              disabled={!session.deviceId}
            />
          ) : (
            <ReadOnlyComposerNote />
          )}
        </div>

        {/* Desktop rail — collapsible (persisted); hidden when collapsed so main
            widens. Pinned below the sticky header (parity with the issue
            Properties rail, ISS-351) so context stays visible while the thread
            scrolls; its own `overflow-y-auto` keeps a long rail usable. */}
        {!railCollapsed && (
          <aside className="hidden w-80 shrink-0 self-start overflow-y-auto border-l border-line px-5 py-6 lg:sticky lg:top-16 lg:block lg:max-h-[calc(100dvh-4rem)]">
            <ContextRail
              session={session}
              items={items}
              projectSlug={projectSlug}
            />
          </aside>
        )}
      </div>

      {/* Mobile rail */}
      <SlideOver
        open={railOpen}
        onClose={() => setRailOpen(false)}
        title="Context"
        width={360}
      >
        <div className="px-4 py-4">
          <ContextRail session={session} items={items} />
        </div>
      </SlideOver>
    </div>
  );
}
