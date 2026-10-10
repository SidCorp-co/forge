"use client";

import {
  ErrorState,
  ProjectLoader,
  useRecordView,
} from "@/design";
import { isJobDriven } from "@/features/sessions";
import {
  deriveSessionDisplayStatus,
} from "@/features/sessions";
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
import { useEffect, useState } from "react";
import { useStuckRuns } from "@/features/agents";
import {
  useForkSession,
  useSession,
  useSessionTurnPages,
} from "../hooks";
import { deriveAgentTasks } from "../derive";
import { parseTurns } from "../types";
import { SessionHeader } from "./session-header";
import { SessionThread } from "./session-thread";
import { RunReport } from "./run-report/run-report";
import { TurnsTruncated } from "./turns-truncated";

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
  // REQ-43 BC-7: the person's view reads the session's state and what it produced; the agent's tool
  // calls, task list, the context rail (box, paths, tokens) and ids are the developer's.
  const [view, setView] = useRecordView();
  const developer = view === "developer";
  // Desktop context-rail collapse (persisted). Below lg the rail is a SlideOver.
  const [railCollapsed, setRailCollapsed] = usePersistedState("web-v2:context-rail", false);

  const session = sessionQ.data;

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
  const items = parseTurns(turnsQ.data?.turns ?? []);
  // Later turns exist past the page cap: the last loaded item is not the session's newest turn.
  const truncated = !!turnsQ.data?.nextCursor;
  const isRun = session ? isJobDriven(session) : false;
  // Task-count indicator (ISS-391) — surfaces "this session ran N agents/skills"
  // in the header without opening the context rail. Same derivation the rail uses.
  const taskCount = deriveAgentTasks(items).length;

  const stuck = useStuckRuns(session?.projectId);
  const display = session ? deriveSessionDisplayStatus(session, stuck) : "queued";
  const live = display === "running" || display === "stalled";
  const lastTurnId = !truncated && items.length ? items[items.length - 1].turnId : undefined;
  const fork = useForkSession(sessionId);

  const goToSession = (id: string) =>
    router.push(`/projects/${projectSlug ?? ""}/agents/${id}`);

  const handleFork = (fromTurnId: string) =>
    fork.mutate(
      { fromTurnId },
      { onSuccess: (s) => projectSlug && goToSession(s.id) },
    );

  if (sessionQ.isLoading) {
    return (
      <div className="flex min-h-dvh flex-col">
        <div className="grid flex-1 place-items-center">
          <ProjectLoader label={t("sessions.detail.loading")} />
        </div>
      </div>
    );
  }

  if (sessionQ.isError || !session) {
    return (
      <div className="flex min-h-dvh flex-col">
        <div className="grid flex-1 place-items-center">
          <ErrorState
            title={t("sessions.detail.loadFailed")}
            message={formatRefusal(sessionQ.error)}
            onRetry={() => void sessionQ.refetch()}
          />
        </div>
      </div>
    );
  }

  const turnsError = turnsQ.isError ? (
    <ErrorState
      title={items.length ? t("sessions.detail.turnsRefreshFailed") : t("sessions.detail.turnsLoadFailed")}
      message={formatRefusal(turnsQ.error)}
      onRetry={() => void turnsQ.refetch()}
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
    <div className="flex min-h-dvh flex-col">
      <SessionHeader
        session={session}
        display={display}
        live={live}
        taskCount={isRun && developer ? taskCount : 0}
        developer={developer}
        onView={setView}
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
            <RunReport session={session} items={items} developer={developer} />
          )}
          {turnsTruncated && <div className="px-4 pb-6 sm:px-6">{turnsTruncated}</div>}
        </>
      ) : (
          <SessionThread
            session={session}
            items={items}
            turnsQ={turnsQ}
            truncated={truncated}
            live={live}
            display={display}
            projectSlug={projectSlug}
            developer={developer}
            railCollapsed={railCollapsed}
            railOpen={railOpen}
            onCloseRail={() => setRailOpen(false)}
            onFork={handleFork}
            turnsError={turnsError}
            turnsTruncated={turnsTruncated}
          />
      )}
    </div>
  );
}
