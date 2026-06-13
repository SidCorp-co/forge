"use client";

// Single-assistant Chat surface (`/projects/[slug]/agent`). Reuses the same
// conversation primitives as the run thread — Conversation + Composer + the
// `['agent-session', …]` hooks — but lighter: no pipeline rail, no fork/rerun.
// Bootstrap = resume the latest interactive `agent` session for the project,
// else create one on first send (ISS-292). ISS-465 adds explicit "draft" mode
// so "New chat" no longer leaves a ghost row, plus rename/archive/delete via
// the conversation-list panel.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AgentWorking,
  Banner,
  Button,
  EmptyState,
  ErrorState,
  ProjectLoader,
  StatusChip,
  useElapsed,
} from "@/design";
import { useProjects } from "@/features/projects/hooks";
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
import { Composer, ReadOnlyComposerNote } from "./composer";
import { Conversation } from "./conversation";
import { ConversationList, EditableTitle } from "./conversation-list";

const AGENT_TYPE = "agent";

export function ChatScreen({ projectId }: { projectId: string }) {
  useRoom(projectRoom(projectId));

  // Viewer = read-only: hide the composer (the server 403s sends regardless).
  const projectsQ = useProjects();
  const canWrite =
    projectsQ.data?.find((p) => p.id === projectId)?.role !== "viewer";

  // Resume the latest interactive agent session for this project, and list a
  // page of recent ones to drive the history switcher (ISS-421). Archived
  // chats are excluded server-side (ISS-465).
  const latestQ = useQuery({
    queryKey: ["agent-sessions", "chat", projectId],
    queryFn: () => sessionApi.listByType(projectId, AGENT_TYPE, 20),
    enabled: !!projectId,
  });

  const [activeId, setActiveId] = useState<string | undefined>();
  // ISS-465 — explicit "draft" state so "New chat" doesn't fall through to
  // recentSessions[0]. A draft never touches the server; the send-path lazy-
  // creates the row on first message (handleSend).
  const [draft, setDraft] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const recentSessions = latestQ.data?.items ?? [];
  const resolvedId = draft ? undefined : activeId ?? recentSessions[0]?.id;

  const sessionQ = useSession(resolvedId);
  const turnsQ = useSessionTurns(resolvedId);
  const items = useMemo(
    () => parseTurns(turnsQ.data?.turns ?? []),
    [turnsQ.data],
  );

  const create = useCreateSession();
  const send = useSendMessage(resolvedId ?? "");
  const regenerate = useRegenerateTurn(resolvedId ?? "");
  const fork = useForkSession(resolvedId ?? "");
  const editTurn = useEditTurn(resolvedId ?? "");

  const session = sessionQ.data;
  const display = session ? deriveSessionDisplayStatus(session) : undefined;
  const live = display === "running" || display === "stalled";
  const startMs = session?.startedAt
    ? new Date(session.startedAt).getTime()
    : undefined;
  const elapsed = useElapsed(startMs, live);

  // Only a GENUINE failure (not a benign lifecycle/capacity cancel or pipeline
  // cleanup) surfaces the recovery banner — mirrors the sessions list (ISS-322).
  const outcome =
    session && display
      ? classifySessionOutcome(display, session.failureReason)
      : undefined;
  const isFailed = outcome?.bucket === "failed";

  // Start a fresh draft chat — no server row until the user sends a message
  // (ISS-465). useSendMessage's onSuccess will invalidate ['agent-sessions']
  // so the history rail picks up the new session once it materialises.
  const handleNewChat = () => {
    setDraft(true);
    setActiveId(undefined);
    setHistoryOpen(false);
  };

  const handlePick = (id: string) => {
    setDraft(false);
    setActiveId(id);
    setHistoryOpen(false);
  };

  // Archiving/deleting the CURRENTLY-resolved conversation would leave a stale
  // `activeId` (or a default-resolved row) pointing at a gone/hidden row →
  // ErrorState. Fall back to a clean draft so the screen resolves to the next
  // recent chat or the empty state (review follow-up, ISS-465).
  const handleActiveRemoved = () => {
    setActiveId(undefined);
    setDraft(false);
  };

  // `await`s the send so a failure rejects up into the Composer, which then
  // keeps the typed text for retry (ISS-462) instead of clearing it. No `title`
  // on create — the server auto-titles from the first user message (ISS-462).
  const handleSend = async (message: string) => {
    let id = resolvedId;
    if (!id) {
      const created = await create.mutateAsync({
        projectId,
        metadata: { type: AGENT_TYPE },
      });
      id = created.id;
      setDraft(false);
      setActiveId(id);
    }
    await send.mutateAsync({ sessionId: id, message });
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
          {/* Title row: editable per-conversation title once a real row exists.
              In draft / no-conversation state, fall back to the section label. */}
          {session ? (
            <h1 className="fg-h2 truncate">
              <EditableTitle session={session} />
            </h1>
          ) : (
            <h1 className="fg-h2">My conversations</h1>
          )}
          <p className="fg-body-sm mt-1 text-muted">
            Ask the agent anything about this project.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {session && display && (
            <StatusChip
              status={statusToChip(display)}
              stage={deriveStage(session.metadata)}
              size="sm"
              domain="session"
            />
          )}
          <div className="relative">
            <Button
              variant="secondary"
              size="sm"
              icon="clock"
              onClick={() => setHistoryOpen((v) => !v)}
              aria-expanded={historyOpen}
              aria-haspopup="dialog"
            >
              History
            </Button>
            <ConversationList
              open={historyOpen}
              onClose={() => setHistoryOpen(false)}
              projectId={projectId}
              rows={recentSessions}
              activeId={resolvedId}
              onPick={(s) => handlePick(s.id)}
              onActiveRemoved={handleActiveRemoved}
            />
          </div>
          <Button variant="secondary" size="sm" icon="plus" onClick={handleNewChat}>
            New chat
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8 xl:max-w-4xl">
          {isFailed && (
            <div className="mb-6">
              <Banner
                tone="danger"
                action={
                  <Button variant="secondary" size="sm" icon="plus" onClick={handleNewChat}>
                    Start new chat
                  </Button>
                }
              >
                <span className="font-medium">
                  {outcome?.label ?? "Chat failed"}
                </span>
                {outcome?.tooltip ? <> — {outcome.tooltip}</> : null}
              </Banner>
            </div>
          )}
          {send.isError && (
            <div className="mb-6">
              <Banner tone="danger">
                <span className="font-medium">Couldn&apos;t send.</span>{" "}
                {formatApiError(send.error)}
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
              onEditTurn={(turnId, content, expectedEditedAt) =>
                editTurn.mutate({ turnId, content, expectedEditedAt })
              }
            />
          )}
          {live && (
            <div className="mt-6">
              <AgentWorking label="Agent is working…" elapsed={elapsed} />
            </div>
          )}
        </div>
      </div>

      {canWrite ? (
        <Composer
          onSend={handleSend}
          busy={busy}
          placeholder="Message the agent…"
        />
      ) : (
        <ReadOnlyComposerNote />
      )}
    </div>
  );
}
