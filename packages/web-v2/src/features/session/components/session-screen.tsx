"use client";

import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  Menu,
  MonoTag,
  PageTitle,
  ProjectLoader,
  SlideOver,
  StatusChip,
  useElapsed,
} from "@/design";
import { isJobDriven } from "@/features/sessions/types";
import {
  deriveSessionDisplayStatus,
  sessionStep,
  statusToChip,
} from "@/features/sessions/types";
import { useCopyShareLink } from "@/lib/navigation/use-copy-share-link";
import { useRecents } from "@/lib/navigation/recents";
import { formatRefusal } from "@/lib/api/error";
import { usePersistedState } from "@/lib/utils/use-persisted-state";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useRouter } from "next/navigation";
import { useCopy } from "@/lib/i18n/interface-language";
// Run-conversation orchestrator (ISS-292). Header (id/title/status + Stop /
// Rerun / Fork), two-pane body (thread + context rail), sticky composer.
// Subscribes to the project WS room so persisted-turn invalidations stream the
// caret + live updates (ISS-291 model — no client-side stream reducer).
import { useEffect, useMemo, useState } from "react";
import { useStuckRuns } from "@/features/agents/hooks";
import { useCancelSession, useRerunSession } from "@/features/sessions/hooks";
import {
  useEditTurn,
  useForkSession,
  useRegenerateTurn,
  useSendMessage,
  useSession,
  useSessionTurnPages,
} from "../hooks";
import { deriveAgentTasks } from "../derive";
import { parseTurns } from "../types";
import { SessionComposer } from "./session-composer";
import { RunReport } from "./run-report/run-report";
import { ContextRail } from "./context-rail";
import { TurnsTruncated } from "./turns-truncated";
import { Conversation } from "./conversation";
import { NewOutput } from "./new-output";
import { DisclosureScope } from "../disclosure";
import { TurnStage, sessionTurnStage } from "./turn-stage";
import { tailOutputSize, useStickToBottom } from "./use-stick-to-bottom";

interface SessionScreenProps {
  sessionId: string;
  /** Back-link target (project sessions index). */
  projectSlug?: string;
}

export function SessionScreen({ sessionId, projectSlug }: SessionScreenProps) {
  const router = useRouter();
  const t = useCopy();
  const { push: pushRecent } = useRecents();
  const sessionQ = useSession(sessionId);
  const { turnsQ, loadMoreTurns } = useSessionTurnPages(sessionId);
  const [railOpen, setRailOpen] = useState(false);
  // Desktop context-rail collapse (persisted). Below lg the rail is a SlideOver.
  const [railCollapsed, setRailCollapsed] = usePersistedState("web-v2:context-rail", false);

  const session = sessionQ.data;
  const issueId = session?.metadata?.issueId;

  // Track this session as recently-viewed (surfaces in the ⌘K Recent group).
  const loadedId = session?.id;
  const sessionTitle = session?.title;
  useEffect(() => {
    if (!loadedId || !projectSlug) return;
    pushRecent({
      kind: "session",
      id: loadedId,
      label: sessionTitle ?? t("sessions.detail.sessionShort", { id: loadedId.slice(0, 8) }),
      href: `/projects/${projectSlug}/agents/${loadedId}`,
      icon: "agent",
    });
  }, [loadedId, sessionTitle, projectSlug, pushRecent, t]);

  // Subscribe to the project room once we know the project — the event-router
  // invalidates ['agent-session', id, 'turns'] on turn.* events.
  useRoom(session ? projectRoom(session.projectId) : null);

  // The turn rows are the session's only transcript. The detail row's `messages` is their last
  // few rows, so it never stands in for them, and a failed turns read is shown as one.
  const items = useMemo(() => parseTurns(turnsQ.data?.turns ?? []), [turnsQ.data]);
  // Later turns exist past the page cap: the last loaded item is not the session's newest turn.
  const truncated = !!turnsQ.data?.nextCursor;
  const isRun = session ? isJobDriven(session) : false;
  // Task-count indicator (ISS-391) — surfaces "this session ran N agents/skills"
  // in the header without opening the context rail. Same derivation the rail uses.
  const taskCount = useMemo(() => deriveAgentTasks(items).length, [items]);

  const send = useSendMessage(sessionId);
  const regenerate = useRegenerateTurn(sessionId);
  const fork = useForkSession(sessionId);
  const editTurn = useEditTurn(sessionId);

  const streamedChars = useMemo(() => tailOutputSize(items), [items]);

  const stuck = useStuckRuns(session?.projectId);
  const display = session ? deriveSessionDisplayStatus(session, stuck) : "queued";
  const live = display === "running" || display === "stalled";
  const startMs = session?.startedAt
    ? new Date(session.startedAt).getTime()
    : undefined;
  const elapsed = useElapsed(startMs, live);

  const lastTurnId = !truncated && items.length ? items[items.length - 1].turnId : undefined;
  const streaming = live && !truncated;

  // What this turn is doing, in the one line that replaced the `AgentWorking` card below the
  // thread (ISS-1083). Which statuses draw which stage is `sessionTurnStage`'s.
  const stage = sessionTurnStage({
    live,
    display,
    truncated,
    ...(items.length ? { tail: items[items.length - 1] } : {}),
  });

  // Auto-scroll the thread to the newest message (ISS-728).
  const { scrollRef, bottomRef, onScroll, atBottom, newOutput, toBottom } = useStickToBottom({
    conversationKey: sessionId,
    ready: turnsQ.isSuccess,
    itemCount: items.length,
    live,
    streaming,
    streamedChars,
  });

  const goToSession = (id: string) =>
    router.push(`/projects/${projectSlug ?? ""}/agents/${id}`);

  const handleFork = (fromTurnId: string) =>
    fork.mutate(
      { fromTurnId },
      { onSuccess: (s) => projectSlug && goToSession(s.id) },
    );

  if (sessionQ.isLoading) {
    return (
      <div className={`flex flex-col min-h-dvh`}>
        <div className="grid flex-1 place-items-center">
          <ProjectLoader label={t("sessions.detail.loading")} />
        </div>
      </div>
    );
  }

  if (sessionQ.isError || !session) {
    return (
      <div className={`flex flex-col min-h-dvh`}>
        <div className="grid flex-1 place-items-center">
          <ErrorState
            title={t("sessions.detail.loadFailed")}
            message={formatRefusal(sessionQ.error)}
            onRetry={() => sessionQ.refetch()}
          />
        </div>
      </div>
    );
  }

  const turnsError = turnsQ.isError ? (
    <ErrorState
      title={items.length ? t("sessions.detail.turnsRefreshFailed") : t("sessions.detail.turnsLoadFailed")}
      message={formatRefusal(turnsQ.error)}
      onRetry={() => turnsQ.refetch()}
      mascot={items.length === 0}
    />
  ) : null;
  const turnsTruncated = truncated && (
    <TurnsTruncated
      loaded={turnsQ.data?.turns.length ?? 0}
      loading={turnsQ.isFetching}
      live={live}
      onLoad={loadMoreTurns}
    />
  );



  return (
    <div className={`flex flex-col min-h-dvh`}>
      <SessionHeader
        session={session}
        display={display}
        live={live}
        taskCount={taskCount}
        projectSlug={projectSlug}
        lastTurnId={lastTurnId}
        onFork={handleFork}
        onOpenSession={goToSession}
        railCollapsed={railCollapsed}
        onToggleRail={() => setRailCollapsed((c) => !c)}
        onOpenRail={() => setRailOpen(true)}
      />

      {isRun ? (
        <>
          {turnsError}
          {!(turnsQ.isError && items.length === 0) && (
            <RunReport
              session={session}
              items={items}
              {...(issueId && projectSlug
                ? { onOpenIssue: () => router.push(`/projects/${projectSlug}/issues/${issueId}`) }
                : {})}
            />
          )}
          {turnsTruncated && <div className="px-4 pb-6 sm:px-6">{turnsTruncated}</div>}
        </>
      ) : (
        <>
      <DisclosureScope atBottom={atBottom}>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 xl:max-w-5xl">
              {turnsQ.isLoading ? (
                <ProjectLoader label={t("sessions.detail.loadingTurns")} size={110} />
              ) : items.length === 0 && turnsError ? (
                turnsError
              ) : items.length === 0 ? (
                live ? null : (
                  <EmptyState title={t("sessions.detail.noMessages")} message={t("sessions.detail.noTurns")} />
                )
              ) : (
                <Conversation
                  items={items}
                  streaming={streaming}
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
              {items.length > 0 && turnsError}
              {turnsTruncated}
              {stage && (
                <div className="mt-3">
                  <TurnStage stage={stage} {...(elapsed ? { elapsed } : {})} />
                </div>
              )}
              {newOutput && <NewOutput onGo={toBottom} />}
              <div ref={bottomRef} />
            </div>
          </div>
          <SessionComposer
            projectId={session.projectId}
            onSend={async (message, files) => {
              await send.mutateAsync({ sessionId, message, files });
            }}
            busy={live || send.isPending}
            disabled={!session.deviceId}
          />
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
      </DisclosureScope>

      {/* Mobile rail */}
      <SlideOver
        open={railOpen}
        onClose={() => setRailOpen(false)}
        title={t("sessions.detail.context")}
        width={360}
      >
        <div className="px-4 py-4">
          <ContextRail session={session} items={items} />
        </div>
      </SlideOver>
        </>
      )}
    </div>
  );
}

function SessionHeader({
  session,
  display,
  live,
  taskCount,
  projectSlug,
  lastTurnId,
  onFork,
  onOpenSession,
  railCollapsed,
  onToggleRail,
  onOpenRail,
}: {
  session: NonNullable<ReturnType<typeof useSession>["data"]>;
  display: ReturnType<typeof deriveSessionDisplayStatus>;
  live: boolean;
  taskCount: number;
  projectSlug: string | undefined;
  lastTurnId: string | undefined;
  onFork: (turnId: string) => void;
  onOpenSession: (id: string) => void;
  railCollapsed: boolean;
  onToggleRail: () => void;
  onOpenRail: () => void;
}) {
  const router = useRouter();
  const t = useCopy();
  const copyShareLink = useCopyShareLink();
  const cancel = useCancelSession();
  const rerun = useRerunSession();
  const issueId = session.metadata?.issueId;
  const goBack = projectSlug ? () => router.push(`/projects/${projectSlug}/agents`) : undefined;
  function copyLink() {
    if (!projectSlug) return;
    copyShareLink(`/projects/${projectSlug}/agents/${session.id}`);
  }

  // Overflow menu — Branch/View runner machine/Copy link (ISS-351). Branching forks from the
  // newest turn, so it is offered only when the newest turn is loaded.
  const menuItems = [
    ...(lastTurnId
      ? [
          {
            label: t("sessions.detail.branch"),
            icon: "fork" as const,
            onSelect: () => onFork(lastTurnId),
          },
        ]
      : []),
    ...(session.deviceId
      ? [
          {
            label: t("sessions.detail.viewRunner"),
            icon: "server" as const,
            onSelect: () => router.push("/runners"),
          },
        ]
      : []),
    {
      label: t("sessions.detail.copyLink"),
      icon: "link" as const,
      onSelect: copyLink,
    },
  ];

  const railToggle = (
    <IconButton
      icon={railCollapsed ? "chevronLeft" : "panelLeft"}
      aria-label={railCollapsed ? t("sessions.detail.showRail") : t("sessions.detail.hideRail")}
      aria-pressed={railCollapsed}
      className="hidden min-h-11 min-w-11 lg:inline-flex"
      onClick={onToggleRail}
    />
  );

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-app/95 px-4 py-3 backdrop-blur sm:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {goBack && (
          <Button
            variant="ghost"
            size="sm"
            icon="arrowRight"
            className="min-h-11 rotate-180"
            aria-label={t("sessions.detail.backToSessions")}
            onClick={goBack}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <PageTitle className="fg-h3 truncate">{session.title ?? t("sessions.detail.session")}</PageTitle>
            <MonoTag hue="cobalt">{session.id.slice(0, 8)}</MonoTag>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <StatusChip
              status={statusToChip(display)}
              stage={sessionStep(session.metadata) ?? undefined}
              size="sm"
              domain="session"
            />
            {taskCount > 0 && (
              <Badge tone="neutral">
                {taskCount === 1 ? t("sessions.detail.taskOne") : t("sessions.detail.taskMany", { n: taskCount })}
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
              onClick={() => cancel.mutate(session.id)}
            >
              {t("sessions.detail.stop")}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              icon="rerun"
              className="min-h-11"
              loading={rerun.isPending}
              onClick={() =>
                rerun.mutate(session.id, {
                  onSuccess: (r) => projectSlug && onOpenSession(r.id),
                })
              }
            >
              {t("sessions.detail.rerun")}
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
              {t("sessions.detail.openIssue")}
            </Button>
          )}
          <Menu
            align="right"
            items={menuItems}
            trigger={
              <IconButton
                icon="more"
                aria-label={t("sessions.detail.actions")}
                className="min-h-11 min-w-11"
              />
            }
          />
          <IconButton
            icon="rows"
            aria-label={t("sessions.detail.showContext")}
            className="min-h-11 min-w-11 lg:hidden"
            onClick={onOpenRail}
          />
          {railToggle}
        </div>
      </div>
    </header>
  );
}
