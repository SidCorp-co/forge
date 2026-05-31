"use client";

// Run-conversation orchestrator (ISS-292). Header (id/title/status + Stop /
// Rerun / Fork), two-pane body (thread + context rail), sticky composer.
// Subscribes to the project WS room so persisted-turn invalidations stream the
// caret + live updates (ISS-291 model — no client-side stream reducer).
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AgentWorking,
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
import { useToast } from "@/providers/toast-provider";
import { usePersistedState } from "@/lib/utils/use-persisted-state";
import { useRecents, buildShareLink } from "@/features/shell";
import {
  deriveSessionDisplayStatus,
  deriveStage,
  statusToChip,
} from "@/features/sessions/types";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { parseTurns } from "../types";
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
import { Composer } from "./composer";
import { Conversation } from "./conversation";
import { ContextRail } from "./context-rail";

interface SessionScreenProps {
  sessionId: string;
  /** Back-link target (project sessions index). */
  projectSlug?: string;
}

export function SessionScreen({ sessionId, projectSlug }: SessionScreenProps) {
  const router = useRouter();
  const { toast } = useToast();
  const { push: pushRecent } = useRecents();
  const sessionQ = useSession(sessionId);
  const turnsQ = useSessionTurns(sessionId);
  const [railOpen, setRailOpen] = useState(false);
  // Desktop context-rail collapse (persisted). Below lg the rail is a SlideOver.
  const [railCollapsed, setRailCollapsed] = usePersistedState("web-v2:context-rail", false);

  const session = sessionQ.data;
  const issueId = session?.metadata?.issueId;

  // Track this session as recently-viewed (surfaces in the ⌘K Recent group).
  useEffect(() => {
    if (!session || !projectSlug) return;
    pushRecent({
      kind: "session",
      id: session.id,
      label: session.title ?? `Session ${session.id.slice(0, 8)}`,
      href: `/projects/${projectSlug}/sessions/${session.id}`,
      icon: "agent",
    });
  }, [session?.id, session?.title, projectSlug, pushRecent]);

  function copyLink() {
    if (!projectSlug) return;
    const url = buildShareLink(`/projects/${projectSlug}/sessions/${sessionId}`);
    navigator.clipboard?.writeText(url).then(
      () => toast({ title: "Link copied", description: url, tone: "success" }),
      () => toast({ title: "Couldn't copy link", tone: "error" }),
    );
  }
  // Subscribe to the project room once we know the project — the event-router
  // invalidates ['agent-session', id, 'turns'] on turn.* events.
  useRoom(session ? projectRoom(session.projectId) : null);

  const items = useMemo(() => parseTurns(turnsQ.data?.turns ?? []), [turnsQ.data]);

  const send = useSendMessage(sessionId);
  const regenerate = useRegenerateTurn(sessionId);
  const fork = useForkSession(sessionId);
  const editTurn = useEditTurn(sessionId);
  const cancel = useCancelSession(sessionId);
  const rerun = useRerunSession(sessionId);

  const display = session ? deriveSessionDisplayStatus(session) : "queued";
  const live = display === "running" || display === "stalled";
  const startMs = session?.startedAt ? new Date(session.startedAt).getTime() : undefined;
  const elapsed = useElapsed(startMs, live);

  const lastTurnId = items.length ? items[items.length - 1].turnId : undefined;

  const goToSession = (id: string) => router.push(`/projects/${projectSlug ?? ""}/sessions/${id}`);

  const handleFork = (fromTurnId: string) =>
    fork.mutate({ fromTurnId }, { onSuccess: (s) => projectSlug && goToSession(s.id) });

  if (sessionQ.isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <ProjectLoader label="loading session…" />
      </div>
    );
  }

  if (sessionQ.isError || !session) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <ErrorState
          title="Couldn't load session"
          message={formatApiError(sessionQ.error)}
          onRetry={() => sessionQ.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-line bg-app/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {projectSlug && (
            <Button
              variant="ghost"
              size="sm"
              icon="arrowRight"
              className="min-h-11 rotate-180"
              aria-label="Back to sessions"
              onClick={() => router.push(`/projects/${projectSlug}/sessions`)}
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="fg-h3 truncate">{session.title ?? "Session"}</h1>
              <MonoTag hue="cobalt">{session.id.slice(0, 8)}</MonoTag>
            </div>
            <div className="mt-1">
              <StatusChip status={statusToChip(display)} stage={deriveStage(session.metadata)} size="sm" />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {live ? (
              <Button variant="danger" size="sm" icon="stop" className="min-h-11" loading={cancel.isPending} onClick={() => cancel.mutate()}>
                Stop
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                icon="rerun"
                className="min-h-11"
                loading={rerun.isPending}
                onClick={() => rerun.mutate(undefined, { onSuccess: (r) => projectSlug && goToSession(r.id) })}
              >
                Rerun
              </Button>
            )}
            {lastTurnId && (
              <Button variant="secondary" size="sm" icon="fork" className="min-h-11" loading={fork.isPending} onClick={() => handleFork(lastTurnId)}>
                Fork
              </Button>
            )}
            <Menu
              align="right"
              items={[
                ...(issueId && projectSlug
                  ? [
                      {
                        label: "Open issue",
                        icon: "list" as const,
                        onSelect: () => router.push(`/projects/${projectSlug}/issues/${issueId}`),
                      },
                    ]
                  : []),
                ...(session.deviceId
                  ? [{ label: "Open runner", icon: "server" as const, onSelect: () => router.push("/runners") }]
                  : []),
                { label: "Copy link", icon: "link" as const, onSelect: copyLink },
              ]}
              trigger={<IconButton icon="more" aria-label="Session actions" className="min-h-11 min-w-11" />}
            />
            <IconButton
              icon="rows"
              aria-label="Show context"
              className="min-h-11 min-w-11 lg:hidden"
              onClick={() => setRailOpen(true)}
            />
            <IconButton
              icon={railCollapsed ? "chevronLeft" : "panelLeft"}
              aria-label={railCollapsed ? "Show context rail" : "Hide context rail"}
              aria-pressed={railCollapsed}
              className="hidden min-h-11 min-w-11 lg:inline-flex"
              onClick={() => setRailCollapsed((c) => !c)}
            />
          </div>
        </div>
      </header>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
              {turnsQ.isLoading ? (
                <ProjectLoader label="loading turns…" size={110} />
              ) : items.length === 0 ? (
                <EmptyState
                  title="No messages yet"
                  message={live ? "The agent is starting up…" : "This session has no turns."}
                />
              ) : (
                <Conversation
                  items={items}
                  streaming={live}
                  busy={live || send.isPending || regenerate.isPending || editTurn.isPending}
                  onRegenerate={(turnId) => regenerate.mutate(turnId)}
                  onFork={handleFork}
                  onEditTurn={(turnId, content, expectedEditedAt) => editTurn.mutate({ turnId, content, expectedEditedAt })}
                />
              )}
              {live && (
                <div className="mt-5">
                  <AgentWorking label="Agent is working…" elapsed={elapsed} />
                </div>
              )}
            </div>
          </div>
          <Composer
            onSend={(message) => send.mutate({ sessionId, message })}
            busy={live || send.isPending}
            disabled={!session.deviceId}
          />
        </div>

        {/* Desktop rail — collapsible (persisted); hidden when collapsed so main widens. */}
        {!railCollapsed && (
          <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-line px-5 py-6 lg:block">
            <ContextRail session={session} items={items} />
          </aside>
        )}
      </div>

      {/* Mobile rail */}
      <SlideOver open={railOpen} onClose={() => setRailOpen(false)} title="Context" width={360}>
        <div className="px-4 py-4">
          <ContextRail session={session} items={items} />
        </div>
      </SlideOver>
    </div>
  );
}
