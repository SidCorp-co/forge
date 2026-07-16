"use client";

// web-v2 workspace surface: Conversations (ISS-668). Chat-only, cross-project
// replacement for the old mixed chat+pipeline "Sessions" workspace page.
// Reuses the already-shipped ISS-664 "waiting for me" ranking + reply panel
// from `features/sessions/*` — this module is presentation + a structural
// `isInteractiveSession` filter, not a rewrite of the chat logic.
import { useMemo, useState } from "react";
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
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { NewConversationPanel } from "./new-conversation-panel";

type ConversationFilter = "all" | "waiting";
const FILTERS: ConversationFilter[] = ["all", "waiting"];
const FILTER_LABEL: Record<ConversationFilter, string> = {
  all: "All",
  waiting: "Waiting for me",
};

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

  const now = Date.now();
  const waitingCount = useMemo(() => rows.filter((r) => isAwaitingReply(r)).length, [rows]);
  const filterOptions: SegmentOption<ConversationFilter>[] = FILTERS.map((f) => ({
    value: f,
    label: `${FILTER_LABEL[f]} ${f === "waiting" ? waitingCount : rows.length}`,
  }));

  const visibleRows = useMemo(() => {
    return rows.filter((row) => (filter === "waiting" ? isAwaitingReply(row) : true));
  }, [rows, filter]);

  return (
    <PageContainer className="min-h-dvh">
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
          {/* Desktop / tablet: dense table. */}
          <div className="hidden md:block">
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
                    onOpen={() => setOpenSessionId(row.id)}
                  />
                ))}
              </TBody>
            </Table>
          </div>

          {/* Mobile: stacked cards — no horizontal page scroll, works at 375px. */}
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

      <NewConversationPanel open={newConversationOpen} onClose={() => setNewConversationOpen(false)} />
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
    <TR>
      <TD className="max-w-[360px]">
        <ConversationIdentity row={row} onOpen={onOpen} />
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
