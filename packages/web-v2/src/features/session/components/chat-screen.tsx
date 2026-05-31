"use client";

// Single-assistant Chat surface (`/v2/projects/[slug]/agent`). Reuses the same
// conversation primitives as the run thread — Conversation + Composer + the
// `['agent-session', …]` hooks — but lighter: no pipeline rail, no fork/rerun.
// Bootstrap = resume the latest interactive `agent` session for the project,
// else create one on first send (ISS-292).
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AgentWorking,
  EmptyState,
  ErrorState,
  ProjectLoader,
  StatusChip,
  useElapsed,
} from "@/design";
import { deriveSessionDisplayStatus, deriveStage, statusToChip } from "@/features/sessions/types";
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

  // Resume the latest interactive agent session for this project, if any.
  const latestQ = useQuery({
    queryKey: ["agent-sessions", "chat", projectId],
    queryFn: () => sessionApi.listByType(projectId, AGENT_TYPE),
    enabled: !!projectId,
  });

  const [activeId, setActiveId] = useState<string | undefined>();
  const resolvedId = activeId ?? latestQ.data?.items[0]?.id;

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
        {session && display && (
          <div className="ml-auto">
            <StatusChip status={statusToChip(display)} stage={deriveStage(session.metadata)} size="sm" />
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8">
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
