"use client";

// web-v2 workspace surface: Conversations (ISS-668). Chat-only, cross-project
// replacement for the old mixed chat+pipeline "Sessions" workspace page.
// Reuses the already-shipped ISS-664 "waiting for me" ranking + reply panel
// from `features/sessions/*` — this module is presentation + a structural
// `isInteractiveSession` filter, not a rewrite of the chat logic.
//
// ISS-689 — desktop split-view: alongside the list, a resizable pane strip
// lets several cross-project conversations stay open and independently
// writable at once. Mobile keeps the original single-session SlideOver flow
// untouched (no split fits a phone width).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  MonoTag,
  PageContainer,
  SegmentedControl,
  SessionRowSkeleton,
  StatusChip,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  type SegmentOption,
} from "@/design";
import { useOrgScopedProjects, useProjects } from "@/features/projects/hooks";
import { conversationTitle } from "@/features/session/components/conversation-list";
import { useSessions } from "@/features/sessions/hooks";
import { SessionReplyPanel } from "@/features/sessions/components/session-reply-panel";
import {
  deriveSessionDisplayStatus,
  isAwaitingReply,
  isInteractiveSession,
  statusToChip,
  type SessionRow,
} from "@/features/sessions/types";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { usePersistedState } from "@/lib/utils/use-persisted-state";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useToast } from "@/providers/toast-provider";
import { ConversationPaneStrip } from "./conversation-pane-strip";
import { useConversationPanes, type AddPaneResult } from "../hooks/use-conversation-panes";
import { NewConversationPanel } from "./new-conversation-panel";

type ConversationFilter = "all" | "waiting";
const FILTERS: ConversationFilter[] = ["all", "waiting"];
const FILTER_LABEL: Record<ConversationFilter, string> = {
  all: "All",
  waiting: "Waiting for me",
};

const LIST_WIDTH_KEY = "web-v2:conversations-list-w";
const DEFAULT_LIST_WIDTH = 360;
const MIN_LIST_WIDTH = 280;
const MAX_LIST_WIDTH = 520;

function clampListWidth(width: number): number {
  return Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, width));
}

/** Zero-render WS room subscription — fans the list out across every visible
 *  (org-scoped) project so a reply anywhere shows up live (mirrors the
 *  Sessions workspace tier's RoomSub pattern). */
function RoomSub({ projectId }: { projectId: string }) {
  useRoom(projectRoom(projectId));
  return null;
}

export function ConversationsScreen() {
  // metadataType:"agent" is REQUIRED here — it's what triggers the server's
  // ISS-522 owner-privacy scoping (eq userId) on the cross-project branch.
  // Without it, other org members' interactive chats (title, id, status,
  // cost) leak into this caller-visible-projects listing.
  const sessionsQ = useSessions({ metadataType: "agent" });
  const projectsQ = useProjects();
  const { projects: orgProjects, projectIds: orgProjectIds } = useOrgScopedProjects();
  const [filter, setFilter] = useState<ConversationFilter>("all");
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const { toast } = useToast();
  const panes = useConversationPanes();

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

  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r] as const)), [rows]);
  const openRow = openSessionId ? rowById.get(openSessionId) : undefined;

  // Drives the pane header's "waiting for me" dot — computed off the full
  // org-scoped row set (not the current segmented filter), so a pane stays
  // marked even while the list view is filtered to something else.
  const awaitingBySession = useMemo(
    () => new Set(rows.filter((r) => isAwaitingReply(r)).map((r) => r.id)),
    [rows],
  );

  const now = Date.now();
  const waitingCount = useMemo(() => rows.filter((r) => isAwaitingReply(r)).length, [rows]);
  const filterOptions: SegmentOption<ConversationFilter>[] = FILTERS.map((f) => ({
    value: f,
    label: `${FILTER_LABEL[f]} ${f === "waiting" ? waitingCount : rows.length}`,
  }));

  const visibleRows = useMemo(() => {
    return rows.filter((row) => (filter === "waiting" ? isAwaitingReply(row) : true));
  }, [rows, filter]);

  // Desktop split: resizable list column width, persisted per-tab.
  const [listWidthPersisted, setListWidthPersisted] = usePersistedState<number>(
    LIST_WIDTH_KEY,
    DEFAULT_LIST_WIDTH,
    { syncTabs: false },
  );
  const [listW, setListW] = useState(listWidthPersisted);
  const listDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  useEffect(() => {
    if (!listDragRef.current) setListW(listWidthPersisted);
  }, [listWidthPersisted]);

  const onListPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      listDragRef.current = { startX: e.clientX, startWidth: listW };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [listW],
  );
  const onListPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = listDragRef.current;
    if (!drag) return;
    setListW(clampListWidth(drag.startWidth + (e.clientX - drag.startX)));
  }, []);
  const onListPointerUp = useCallback((e: React.PointerEvent) => {
    const drag = listDragRef.current;
    if (!drag) return;
    listDragRef.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    setListWidthPersisted(clampListWidth(drag.startWidth + (e.clientX - drag.startX)));
  }, [setListWidthPersisted]);

  // Shared by both the list-row click and the "New conversation" → pane
  // handoff: adds the pane and surfaces the cap as a soft toast (never an
  // error page). On "exists", scrolls the already-open pane into view instead
  // of opening a duplicate.
  const handleOpenPane = useCallback(
    (entry: { sessionId: string; projectId: string }): AddPaneResult => {
      const result = panes.addPane(entry);
      if (result === "cap") {
        toast({
          tone: "info",
          title: "You can open up to 4 conversations at once",
          description: "Close one to open another.",
        });
      } else if (result === "exists") {
        document
          .querySelector(`[data-pane-session="${entry.sessionId}"]`)
          ?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      }
      return result;
    },
    [panes, toast],
  );

  return (
    <PageContainer className="flex min-h-dvh flex-col">
      {orgProjects.map((p) => (
        <RoomSub key={p.id} projectId={p.id} />
      ))}

      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="fg-h2">Conversations</h1>
        <Button variant="primary" size="sm" icon="plus" onClick={() => setNewConversationOpen(true)}>
          New conversation
        </Button>
      </header>

      <div className="mb-4 flex flex-wrap gap-3 overflow-x-auto">
        <SegmentedControl options={filterOptions} value={filter} onChange={setFilter} />
      </div>

      {sessionsQ.isLoading && (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {Array.from({ length: 6 }).map((_, i) => (
            <SessionRowSkeleton key={i} />
          ))}
        </div>
      )}

      {sessionsQ.isError && (
        <ErrorState
          title="Couldn't load conversations"
          message={formatApiError(sessionsQ.error)}
          onRetry={() => sessionsQ.refetch()}
        />
      )}

      {!sessionsQ.isLoading && !sessionsQ.isError && rows.length === 0 && (
        <EmptyState
          title="No conversations yet"
          message="Start a conversation with the agent on any project — it'll show up here."
          action={{ label: "New conversation", onClick: () => setNewConversationOpen(true) }}
        />
      )}

      {!sessionsQ.isLoading && !sessionsQ.isError && rows.length > 0 && visibleRows.length === 0 && (
        // ISS-664 convention carried over: "waiting" empty is a good outcome
        // (caught up), not a dead-end "nothing matches" state.
        <EmptyState
          title="You're all caught up"
          message="No conversations are waiting on your reply right now."
          mascot={false}
        />
      )}

      {!sessionsQ.isLoading && !sessionsQ.isError && visibleRows.length > 0 && (
        <>
          {/* Desktop / tablet: split — resizable list column + pane strip. */}
          <div className="hidden min-h-0 flex-1 gap-3 md:flex">
            <div className="flex min-h-0 flex-none flex-col" style={{ width: listW }}>
              <div className="min-h-0 flex-1 overflow-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>Conversation</TH>
                      <TH>Project</TH>
                      <TH>Status</TH>
                      <TH className="text-right">Updated</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {visibleRows.map((row) => (
                      <ConversationTableRow
                        key={row.id}
                        row={row}
                        project={nameById.get(row.projectId)}
                        now={now}
                        open={panes.isOpen(row.id)}
                        onOpen={() => handleOpenPane({ sessionId: row.id, projectId: row.projectId })}
                      />
                    ))}
                  </TBody>
                </Table>
              </div>
            </div>

            {/* Splitter between the list and the pane strip. */}
            <div
              role="separator"
              aria-orientation="vertical"
              onPointerDown={onListPointerDown}
              onPointerMove={onListPointerMove}
              onPointerUp={onListPointerUp}
              onPointerCancel={onListPointerUp}
              title="Drag to resize"
              className="w-1.5 flex-none cursor-col-resize touch-none rounded-sm bg-transparent transition-colors hover:bg-[color:var(--link)]"
            />

            <ConversationPaneStrip
              panes={panes.panes}
              projectById={nameById}
              awaitingBySession={awaitingBySession}
              onClosePane={panes.removePane}
              onResizePane={panes.resizePane}
            />
          </div>

          {/* Mobile: stacked cards — no horizontal page scroll, works at 375px.
              No split here; single-session SlideOver overlay stays the flow. */}
          <div className="space-y-2.5 md:hidden">
            {visibleRows.map((row) => (
              <ConversationMobileCard
                key={row.id}
                row={row}
                project={nameById.get(row.projectId)}
                now={now}
                onOpen={() => setOpenSessionId(row.id)}
              />
            ))}
          </div>
        </>
      )}

      <SessionReplyPanel
        sessionId={openSessionId}
        slug={openRow ? nameById.get(openRow.projectId)?.slug : undefined}
        onClose={() => setOpenSessionId(null)}
      />

      <NewConversationPanel
        open={newConversationOpen}
        onClose={() => setNewConversationOpen(false)}
        onOpenPane={handleOpenPane}
      />
    </PageContainer>
  );
}

function ConversationIdentity({ row, onOpen }: { row: SessionRow; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-h-[44px] w-full items-center text-left focus-visible:outline-none"
    >
      <span className="fg-body-sm block truncate text-fg hover:text-accent-text">
        {conversationTitle(row)}
      </span>
    </button>
  );
}

function ConversationTableRow({
  row,
  project,
  now,
  open,
  onOpen,
}: {
  row: SessionRow;
  project: { name: string; slug: string } | undefined;
  now: number;
  /** Already open as a desktop pane (ISS-689). */
  open?: boolean;
  onOpen: () => void;
}) {
  const display = deriveSessionDisplayStatus(row, now);
  const chipStatus = isAwaitingReply(row) ? "waiting" : statusToChip(display);
  return (
    <TR>
      <TD className="max-w-[360px]">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <ConversationIdentity row={row} onOpen={onOpen} />
          </div>
          {open && <MonoTag hue="cobalt">Open</MonoTag>}
        </div>
      </TD>
      <TD className="max-w-[180px]">
        {project ? (
          <span className="fg-body-sm truncate text-muted">{project.name}</span>
        ) : (
          <MonoTag hue="neutral">{row.projectId.slice(0, 8)}</MonoTag>
        )}
      </TD>
      <TD>
        <StatusChip status={chipStatus} domain="session" />
      </TD>
      <TD className="whitespace-nowrap text-right font-mono text-muted">
        {formatRelativeTime(row.updatedAt)}
      </TD>
    </TR>
  );
}

function ConversationMobileCard({
  row,
  project,
  now,
  onOpen,
}: {
  row: SessionRow;
  project: { name: string; slug: string } | undefined;
  now: number;
  onOpen: () => void;
}) {
  const display = deriveSessionDisplayStatus(row, now);
  const chipStatus = isAwaitingReply(row) ? "waiting" : statusToChip(display);
  return (
    <Card>
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <ConversationIdentity row={row} onOpen={onOpen} />
          <StatusChip status={chipStatus} domain="session" />
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          {project ? (
            <span className="fg-body-sm truncate text-muted">{project.name}</span>
          ) : (
            <MonoTag hue="neutral">{row.projectId.slice(0, 8)}</MonoTag>
          )}
          <span className="fg-caption text-subtle">{formatRelativeTime(row.updatedAt)}</span>
        </div>
      </CardContent>
    </Card>
  );
}
