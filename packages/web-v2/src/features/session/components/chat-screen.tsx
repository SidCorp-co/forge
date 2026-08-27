"use client";

// Single-assistant Chat surface (`/projects/[slug]/agent`). Reuses the same
// conversation primitives as the run thread — Conversation + Composer + the
// `['agent-session', …]` hooks — but lighter: no pipeline rail, no fork/rerun.
// Bootstrap = resume the latest interactive `agent` session for the project,
// else create one on first send (ISS-292). ISS-465 adds explicit "draft" mode
// so "New chat" no longer leaves a ghost row, plus rename/archive/delete via
// the conversation-list panel.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AgentWorking,
  Banner,
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  ProjectLoader,
  StatusChip,
  useElapsed,
} from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { useInvokableSkills } from "@/features/skills/hooks";
import { useOrgMembers } from "@/features/orgs/hooks";
import { MEMBER_LENS_OPTIONS } from "@/features/orgs/types";
import { useAuth } from "@/providers/auth-provider";
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
  useSetSessionRunner,
} from "../hooks";
import { parseTurns } from "../types";
import { readSessionModel } from "../session-model";
import { useModelPick } from "../use-model-pick";
import { Composer, ReadOnlyComposerNote } from "./composer";
import { ModelPicker } from "./model-picker";
import { Conversation } from "./conversation";
import { ConversationList, EditableTitle } from "./conversation-list";
import { RunnerPicker } from "./runner-picker";
import { useStickToBottom } from "./use-stick-to-bottom";

const AGENT_TYPE = "agent";

export function ChatScreen({
  projectId,
  onClose,
  initialDraft,
  onSessionActive,
  activeSessionId,
  hideHistory,
}: {
  projectId: string;
  /** When set (docked panel), render a close control in the header to collapse
   *  the panel. Omitted when the screen owns the full viewport. */
  onClose?: () => void;
  /** Start in draft mode instead of resuming the project's latest chat (ISS-668
   *  "New conversation" flow — the project may already have chats, so the
   *  default resume-latest behavior would silently reopen an old one). */
  initialDraft?: boolean;
  /** Fires whenever the resolved conversation is a real (non-draft) session —
   *  on resume and again once a draft's first send creates one (ISS-689 "Open
   *  as pane" flow). Additive/optional: existing callers are unaffected. */
  onSessionActive?: (sessionId: string) => void;
  /** Open this specific session instead of resuming the project's latest chat
   *  (ISS-729 conversations redesign — the caller owns selection and mounts a
   *  fresh `ChatScreen` per pick via `key`, so this only needs to seed the
   *  INITIAL id). Ignored when `initialDraft` is set. */
  activeSessionId?: string;
  /** Hide the in-header History + New-chat controls (ISS-729) — set when a
   *  caller renders its own history sidebar/list and owns those actions. */
  hideHistory?: boolean;
}) {
  useRoom(projectRoom(projectId));

  // Viewer = read-only: hide the composer (the server 403s sends regardless).
  const projectsQ = useProjects();
  const project = projectsQ.data?.find((p) => p.id === projectId);
  const canWrite = project?.role !== "viewer";

  // Reader's assigned working lens(es) for this project's org (role-aware chat).
  // Read-only here — owner/admin assigns them in Member management; we only
  // surface WHICH lens is shaping the answers, so the shaping isn't invisible.
  const { user } = useAuth();
  const membersQ = useOrgMembers(project?.orgId);
  const myLenses = useMemo(
    () => membersQ.data?.find((m) => m.userId === user?.id)?.lenses ?? [],
    [membersQ.data, user?.id],
  );

  // Resume the latest interactive agent session for this project, and list a
  // page of recent ones to drive the history switcher (ISS-421). Archived
  // chats are excluded server-side (ISS-465).
  const latestQ = useQuery({
    queryKey: ["agent-sessions", "chat", projectId],
    queryFn: () => sessionApi.listByType(projectId, AGENT_TYPE, 20),
    enabled: !!projectId,
  });

  const [activeId, setActiveId] = useState<string | undefined>(
    initialDraft ? undefined : activeSessionId,
  );
  // ISS-465 — explicit "draft" state so "New chat" doesn't fall through to
  // recentSessions[0]. A draft never touches the server; the send-path lazy-
  // creates the row on first message (handleSend).
  const [draft, setDraft] = useState(initialDraft ?? false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // cm:why draft-mode pick only — a real session's runner is the server pin (session.deviceId via POST /:id/runner), not this state
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | undefined>();

  const recentSessions = latestQ.data?.items ?? [];
  const resolvedId = draft ? undefined : activeId ?? recentSessions[0]?.id;

  // Latest-ref so the effect below doesn't need onSessionActive as a dep (a
  // caller passing an inline function shouldn't re-fire the callback on every
  // render, only when the resolved session actually changes).
  const onSessionActiveRef = useRef(onSessionActive);
  onSessionActiveRef.current = onSessionActive;
  useEffect(() => {
    if (resolvedId) onSessionActiveRef.current?.(resolvedId);
  }, [resolvedId]);

  // cm:why fetched for the PROJECT, not the session, so the list is already warm when a draft chat turns into a real one
  const skillsQ = useInvokableSkills(projectId);

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
  const setRunner = useSetSessionRunner(resolvedId ?? "");

  const session = sessionQ.data;
  // cm:why the model pick has no save endpoint (ISS-718) — it rides the next `send`, so a failure surfaces through the existing send error path and needs no second one
  const persistedModel = readSessionModel(session?.metadata);
  const modelPick = useModelPick(persistedModel);
  const display = session ? deriveSessionDisplayStatus(session) : undefined;
  const live = display === "running" || display === "stalled";
  // cm:edge contract -> packages/core/src/agent-sessions/lifecycle-routes.ts — mirrors the POST /:id/runner SESSION_BUSY guard (running/queued) so the picker states the reason before the round-trip
  const switchLocked = live || display === "queued";
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
    setSelectedDeviceId(undefined);
    modelPick.reset();
    setHistoryOpen(false);
  };

  const handleRunnerSelect = (deviceId: string | undefined, label: string) => {
    if (!resolvedId) {
      setSelectedDeviceId(deviceId);
      return;
    }
    setRunner.mutate({ deviceId: deviceId ?? null, label });
  };

  const handlePick = (id: string) => {
    setDraft(false);
    setActiveId(id);
    // cm:why follow the newly-opened conversation's own runner binding and model rather than carrying the previous chat's picks across
    setSelectedDeviceId(undefined);
    modelPick.reset();
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
  const handleSend = async (message: string, files: File[] = []) => {
    let id = resolvedId;
    if (!id) {
      const created = await create.mutateAsync({
        projectId,
        metadata: { type: AGENT_TYPE },
        // Pre-pin the picked runner so the fresh row shows it immediately; the
        // send below re-asserts it as the dispatch override.
        ...(selectedDeviceId ? { deviceId: selectedDeviceId } : {}),
      });
      id = created.id;
      setDraft(false);
      setActiveId(id);
    }
    // cm:guard both picks ride this ONE call: an explicit deviceId re-pins + dispatches this turn to that runner (omitted = reuse the binding / auto-pick), and the model pick is persisted by this same send — so neither may be cleared before it resolves. A throw keeps them for the retry, the contract the composer already keeps for the typed text.
    const sentModel = modelPick.pendingModel;
    await send.mutateAsync({
      sessionId: id,
      message,
      files,
      deviceId: selectedDeviceId,
      model: sentModel,
    });
    if (selectedDeviceId !== undefined) setSelectedDeviceId(undefined);
    // cm:why the pick has applied to a real turn here; useModelPick retires it only once the refetched row agrees, so the trigger never regresses to the previous model in between
    modelPick.markSent(sentModel);
  };

  const busy = live || send.isPending || create.isPending;

  // Auto-scroll the thread to the newest message (ISS-522, ISS-728).
  const { scrollRef, bottomRef, onScroll } = useStickToBottom({
    conversationKey: resolvedId,
    ready: turnsQ.isSuccess,
    itemCount: items.length,
    live,
  });

  if (latestQ.isLoading) {
    return (
      <div className="grid h-full min-h-0 place-items-center py-12">
        <ProjectLoader label="loading chat…" />
      </div>
    );
  }

  if (latestQ.isError) {
    return (
      <div className="grid h-full min-h-0 place-items-center px-4 py-12">
        <ErrorState
          title="Couldn't load chat"
          message={formatApiError(latestQ.error)}
          onRetry={() => latestQ.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* `@container` so the header reflows on the PANEL width, not the viewport
          — the docked split panel (ChatDock) is narrow even on a wide desktop,
          so viewport `sm:` breakpoints would wrongly force the wide single-row
          layout and crush the title. Stack by default; go single-row only once
          the panel itself is wide enough (@[560px]). */}
      <header className="@container flex-none border-b border-line bg-app/95 px-4 py-3">
        <div className="flex flex-col gap-2 @[560px]:flex-row @[560px]:items-center @[560px]:gap-3">
          <div className="min-w-0">
            {/* Title row: editable per-conversation title once a real row exists.
                In draft / no-conversation state, fall back to the section label. */}
            {session ? (
              <h1 className="fg-h2 truncate">
                <EditableTitle session={session} />
              </h1>
            ) : (
              <h1 className="fg-h2 truncate">My conversations</h1>
            )}
            <div className="mt-0.5 hidden flex-wrap items-center gap-x-2 gap-y-1 @[560px]:flex">
              <p className="fg-body-sm text-muted">
                Ask the agent anything about this project.
              </p>
              {myLenses.length > 0 && (
                <span
                  className="flex items-center gap-1"
                  title="Your working lens (set by your org admin) — it shapes how the agent answers you"
                >
                  {MEMBER_LENS_OPTIONS.filter((o) => myLenses.includes(o.value)).map((o) => (
                    <span
                      key={o.value}
                      className="rounded-pill bg-accent-tint px-1.5 py-0.5 text-[10.5px] font-medium text-accent-text"
                    >
                      {o.label}
                    </span>
                  ))}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 @[560px]:ml-auto @[560px]:flex-nowrap">
          {session && display && (
            <StatusChip
              status={statusToChip(display)}
              stage={deriveStage(session.metadata)}
              size="sm"
              domain="session"
            />
          )}
          <RunnerPicker
            projectId={projectId}
            boundDeviceId={session?.deviceId ?? null}
            selectedDeviceId={selectedDeviceId}
            onSelect={handleRunnerSelect}
            readOnly={!canWrite}
            switching={setRunner.isPending}
            pendingNote={!resolvedId ? "Applies to your first message." : null}
            lockedReason={switchLocked ? "The agent is busy — you can switch when it's free." : null}
          />
          {!hideHistory && (
            <div className="relative">
              <Button
                variant="secondary"
                size="sm"
                icon="clock"
                className="min-h-11 @[560px]:min-h-0"
                aria-label="History"
                onClick={() => setHistoryOpen((v) => !v)}
                aria-expanded={historyOpen}
                aria-haspopup="dialog"
              >
                <span className="hidden @[560px]:inline">History</span>
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
          )}
          {!hideHistory && (
            <Button
              variant="secondary"
              size="sm"
              icon="plus"
              className="min-h-11 @[560px]:min-h-0"
              aria-label="New chat"
              onClick={handleNewChat}
            >
              <span className="hidden @[560px]:inline">New chat</span>
            </Button>
          )}
          {onClose && (
            <IconButton
              icon="x"
              size="sm"
              aria-label="Close chat panel"
              onClick={onClose}
            />
          )}
          </div>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto"
      >
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
          {/* Scroll anchor for auto-scroll-to-bottom (ISS-522). */}
          <div ref={bottomRef} />
        </div>
      </div>

      {canWrite ? (
        <Composer
          onSend={handleSend}
          busy={busy}
          allowAttachments
          sticky={false}
          actions={
            <ModelPicker
              activeModel={persistedModel}
              pendingModel={modelPick.pendingModel}
              unsent={modelPick.unsent}
              onSelect={modelPick.select}
              loading={sessionQ.isLoading}
            />
          }
          slashSkills={{
            items: skillsQ.data ?? [],
            loading: skillsQ.isLoading,
            error: skillsQ.error,
            // cm:why isFetching, not isLoading — isLoading is false while REFETCHING a query already in `error` status, which is exactly the retry press the panel has to acknowledge
            fetching: skillsQ.isFetching,
            retry: () => void skillsQ.refetch(),
          }}
        />
      ) : (
        <ReadOnlyComposerNote sticky={false} />
      )}
    </div>
  );
}
