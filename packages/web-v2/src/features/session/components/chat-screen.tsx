"use client";

// Single-assistant Chat surface (`/projects/[slug]/agent`). Reuses the same
// conversation primitives as the run thread — Conversation + Composer + the
// `['agent-session', …]` hooks — but lighter: no pipeline rail, no fork/rerun.
// Bootstrap = resume the latest interactive `agent` session for the project,
// else create one on first send (ISS-292).
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AgentWorking,
  Banner,
  Button,
  EmptyState,
  ErrorState,
  Menu,
  ProjectLoader,
  StatusChip,
  useElapsed,
  type MenuItem,
} from "@/design";
import {
  classifySessionOutcome,
  deriveSessionDisplayStatus,
  deriveStage,
  statusToChip,
} from "@/features/sessions/types";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { sessionApi } from "../api";
import {
  useCreateSession,
  useEditTurn,
  useForkSession,
  useRegenerateTurn,
  useSendMessage,
  useSession,
  useSessionTurns,
} from "../hooks";
import { parseTurns } from "../types";
import { Composer } from "./composer";
import { Conversation } from "./conversation";

const AGENT_TYPE = "agent";

export function ChatScreen({ projectId }: { projectId: string }) {
  useRoom(projectRoom(projectId));

  // Resume the latest interactive agent session for this project, and list a
  // page of recent ones to drive the history switcher (ISS-421).
  const latestQ = useQuery({
    queryKey: ["agent-sessions", "chat", projectId],
    queryFn: () => sessionApi.listByType(projectId, AGENT_TYPE, 20),
    enabled: !!projectId,
  });

  const [activeId, setActiveId] = useState<string | undefined>();
  const recentSessions = latestQ.data?.items ?? [];
  const resolvedId = activeId ?? recentSessions[0]?.id;

  const sessionQ = useSession(resolvedId);
  const turnsQ = useSessionTurns(resolvedId);
  const items = useMemo(() => parseTurns(turnsQ.data?.turns ?? []), [turnsQ.data]);

  const create = useCreateSession();
  const send = useSendMessage(resolvedId ?? "");
  const regenerate = useRegenerateTurn(resolvedId ?? "");
  const fork = useForkSession(resolvedId ?? "");
  const editTurn = useEditTurn(resolvedId ?? "");

  const session = sessionQ.data;
  const display = session ? deriveSessionDisplayStatus(session) : undefined;
  const live = display === "running" || display === "stalled";
  const startMs = session?.startedAt ? new Date(session.startedAt).getTime() : undefined;
  const elapsed = useElapsed(startMs, live);

  // Only a GENUINE failure (not a benign lifecycle/capacity cancel or pipeline
  // cleanup) surfaces the recovery banner — mirrors the sessions list (ISS-322).
  const outcome = session && display ? classifySessionOutcome(display, session.failureReason) : undefined;
  const isFailed = outcome?.bucket === "failed";

  // Start a fresh chat WITHOUT deleting the current one. useCreateSession's
  // onSuccess invalidates ['agent-sessions'], which prefix-matches this list
  // query, so the history switcher refetches with the new session.
  const handleNewChat = async () => {
    const created = await create.mutateAsync({
      projectId,
      title: "Chat",
      metadata: { type: AGENT_TYPE },
    });
    setActiveId(created.id);
  };

  const historyItems: MenuItem[] = recentSessions.map((s) => ({
    label: `${s.id === resolvedId ? "● " : ""}${s.title?.trim() || `Chat ${s.id.slice(0, 8)}`}`,
    onSelect: () => setActiveId(s.id),
  }));

  const handleSend = async (message: string) => {
    let id = resolvedId;
    if (!id) {
      const created = await create.mutateAsync({
        projectId,
        title: "Chat",
        metadata: { type: AGENT_TYPE },
      });
      id = created.id;
      setActiveId(id);
    }
    send.mutate({ sessionId: id, message });
  };

  const busy = live || send.isPending || create.isPending;

  if (latestQ.isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <ProjectLoader label="loading chat…" />
      </div>
    );
  }

  if (latestQ.isError) {
    return (
      <div className="grid min-h-dvh place-items-center px-4">
        <ErrorState
          title="Couldn't load chat"
          message={formatApiError(latestQ.error)}
          onRetry={() => latestQ.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-app/95 px-4 py-4 backdrop-blur sm:px-8">
        <div className="min-w-0">
          <h1 className="fg-h2">Agent chat</h1>
          <p className="fg-body-sm mt-1 text-muted">Ask the agent anything about this project.</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {session && display && (
            <StatusChip status={statusToChip(display)} stage={deriveStage(session.metadata)} size="sm" domain="session" />
          )}
          {historyItems.length > 1 && (
            <Menu
              align="right"
              items={historyItems}
              trigger={
                <Button variant="secondary" size="sm" icon="clock">
                  History
                </Button>
              }
            />
          )}
          <Button
            variant="secondary"
            size="sm"
            icon="plus"
            loading={create.isPending}
            onClick={handleNewChat}
          >
            New chat
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8">
          {isFailed && (
            <div className="mb-6">
              <Banner
                tone="danger"
                action={
                  <Button variant="secondary" size="sm" icon="plus" loading={create.isPending} onClick={handleNewChat}>
                    Start new chat
                  </Button>
                }
              >
                <span className="font-medium">{outcome?.label ?? "Chat failed"}</span>
                {outcome?.tooltip ? <> — {outcome.tooltip}</> : null}
              </Banner>
            </div>
          )}
          {!resolvedId || items.length === 0 ? (
            <div className="grid min-h-[40dvh] place-items-center">
              <EmptyState
                title="Start a conversation"
                message="Ask the agent anything about this project — it has your repo + pipeline context."
                mascot
              />
            </div>
          ) : (
            <Conversation
              items={items}
              streaming={live}
              busy={busy || regenerate.isPending || editTurn.isPending}
              onRegenerate={(turnId) => regenerate.mutate(turnId)}
              onFork={(fromTurnId) => fork.mutate({ fromTurnId })}
              onEditTurn={(turnId, content, expectedEditedAt) => editTurn.mutate({ turnId, content, expectedEditedAt })}
            />
          )}
          {live && (
            <div className="mt-6">
              <AgentWorking label="Agent is working…" elapsed={elapsed} />
            </div>
          )}
        </div>
      </div>

      <Composer onSend={handleSend} busy={busy} placeholder="Message the agent…" />
    </div>
  );
}
