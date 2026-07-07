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
} from "../hooks";
import { parseTurns } from "../types";
import { Composer, ReadOnlyComposerNote } from "./composer";
import { Conversation } from "./conversation";
import { ConversationList, EditableTitle } from "./conversation-list";
import { RunnerPicker } from "./runner-picker";

const AGENT_TYPE = "agent";

export function ChatScreen({
  projectId,
  onClose,
}: {
  projectId: string;
  /** When set (docked panel), render a close control in the header to collapse
   *  the panel. Omitted when the screen owns the full viewport. */
  onClose?: () => void;
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

  const [activeId, setActiveId] = useState<string | undefined>();
  // ISS-465 — explicit "draft" state so "New chat" doesn't fall through to
  // recentSessions[0]. A draft never touches the server; the send-path lazy-
  // creates the row on first message (handleSend).
  const [draft, setDraft] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Explicit runner pick (RunnerPicker). undefined = Auto / follow the session's
  // binding; a set value re-pins the conversation on the next message.
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | undefined>();

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
    setSelectedDeviceId(undefined);
    setHistoryOpen(false);
  };

  const handlePick = (id: string) => {
    setDraft(false);
    setActiveId(id);
    // Follow the newly-opened conversation's own runner binding rather than
    // carrying the previous chat's pick across.
    setSelectedDeviceId(undefined);
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
    // Pass the explicit runner pick (if any) so the server re-pins + dispatches
    // this turn to it; omitted = reuse binding / auto-pick.
    await send.mutateAsync({ sessionId: id, message, files, deviceId: selectedDeviceId });
  };

  const busy = live || send.isPending || create.isPending;

  // Auto-scroll the thread to the newest message (ISS-522). The container opens
  // at the OLDEST turn otherwise (turns render oldest→newest), forcing the user
  // to scroll far down. Strategy:
  //  - jump to bottom (instant) on conversation switch + once turns first load
  //    for a given conversation (one-shot via lastJumpedIdRef);
  //  - stick to bottom (smooth) on new turn / stream change ONLY when the user
  //    is already near the bottom, so reading history isn't interrupted (AC3).
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const lastJumpedIdRef = useRef<string | undefined>(undefined);

  const handleThreadScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Conversation switch: reset the one-shot guard and jump to bottom once the
  // freshly-resolved conversation's turns have loaded.
  useEffect(() => {
    if (!resolvedId) return;
    if (!turnsQ.isSuccess) return;
    if (lastJumpedIdRef.current === resolvedId) return;
    lastJumpedIdRef.current = resolvedId;
    atBottomRef.current = true;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [resolvedId, turnsQ.isSuccess]);

  // Growth / stream: keep pinned to latest only when already near the bottom.
  useEffect(() => {
    if (atBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [items.length, live]);

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
            <p className="fg-body-sm mt-0.5 truncate text-muted">
              Ask the agent anything about this project.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 @[560px]:ml-auto @[560px]:flex-nowrap">
          {myLenses.length > 0 && (
            <span
              className="hidden items-center gap-1 @[520px]:flex"
              title="Your working lens (set by your org admin) — it shapes how the agent answers you"
            >
              {MEMBER_LENS_OPTIONS.filter((o) => myLenses.includes(o.value)).map((o) => (
                <span
                  key={o.value}
                  className="rounded-pill bg-accent-tint px-2 py-0.5 text-[11px] font-medium text-accent-text"
                >
                  {o.label}
                </span>
              ))}
            </span>
          )}
          {session && display && (
            <StatusChip
              status={statusToChip(display)}
              stage={deriveStage(session.metadata)}
              size="sm"
              domain="session"
            />
          )}
          {/* Which runner handles this conversation + pick another (ISS runner
              picker). Bound id is live via session.deviceId; a fresh draft shows
              "Auto" until the first message pins one. */}
          <RunnerPicker
            projectId={projectId}
            boundDeviceId={session?.deviceId ?? null}
            selectedDeviceId={selectedDeviceId}
            onSelect={setSelectedDeviceId}
            readOnly={!canWrite}
          />
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
        onScroll={handleThreadScroll}
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
          placeholder="Message the agent…"
          allowAttachments
          sticky={false}
        />
      ) : (
        <ReadOnlyComposerNote sticky={false} />
      )}
    </div>
  );
}
