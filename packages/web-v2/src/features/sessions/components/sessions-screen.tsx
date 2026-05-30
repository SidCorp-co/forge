"use client";

// web-v2 shared Sessions index — used at BOTH the workspace tier
// (`/v2/sessions`, cross-project, no `scope.projectId`) and the project tier
// (`/v2/projects/[slug]/sessions`, scoped + Sweep zombies). ISS-291.
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  IconButton,
  Menu,
  MonoTag,
  PipelineTracker,
  SegmentedControl,
  SessionRowSkeleton,
  StatusChip,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Tooltip,
  useElapsed,
  type MenuItem,
  type SegmentOption,
} from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import {
  useAbortSession,
  useCancelSession,
  useRerunSession,
  useRetrySession,
  useSessions,
  useSweepZombies,
} from "../hooks";
import {
  deriveSessionDisplayStatus,
  deriveStage,
  isRetryable,
  statusToChip,
  statusToRun,
  type AgentSessionDisplayStatus,
  type SessionFilter,
  type SessionRow,
} from "../types";

interface SessionsScreenProps {
  /** Project-tier scope. Omit for the cross-project workspace tier. */
  scope?: { projectId?: string };
}

/** Mirror of `useElapsed`'s formatter for static (terminal) durations. */
function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

const FILTERS: SessionFilter[] = ["all", "running", "queued", "attention"];
const FILTER_LABEL: Record<SessionFilter, string> = {
  all: "All",
  running: "Running",
  queued: "Queued",
  attention: "Attention",
};

function matchesFilter(filter: SessionFilter, row: SessionRow, display: AgentSessionDisplayStatus): boolean {
  switch (filter) {
    case "running":
      return display === "running" || display === "stalled";
    case "queued":
      return row.status === "queued" || row.status === "idle";
    case "attention":
      return display === "failed" || display === "stalled" || display === "cancelled_stale";
    default:
      return true;
  }
}

/** Zero-render WS room subscription — used to fan out across visible projects. */
function RoomSub({ projectId }: { projectId: string }) {
  useRoom(projectRoom(projectId));
  return null;
}

export function SessionsScreen({ scope }: SessionsScreenProps) {
  const projectId = scope?.projectId;
  const sessionsQ = useSessions({ projectId });
  const projectsQ = useProjects();
  const [filter, setFilter] = useState<SessionFilter>("all");

  // Live updates: project tier subscribes to its room; workspace tier fans out
  // across every visible project. The event-router invalidates ['agent-sessions'].
  useRoom(projectId ? projectRoom(projectId) : null);

  const cancel = useCancelSession();
  const retry = useRetrySession();
  const rerun = useRerunSession();
  const abort = useAbortSession();
  const sweep = useSweepZombies();

  const rows = useMemo(() => sessionsQ.data?.items ?? [], [sessionsQ.data]);

  // Derive once per render so display status, stats, and filters all agree.
  const now = Date.now();
  const displays = useMemo(
    () => rows.map((r) => deriveSessionDisplayStatus(r, now)),
    [rows, now],
  );

  const stats = useMemo(() => {
    let active = 0;
    let queued = 0;
    let zombies = 0;
    const waits: number[] = [];
    rows.forEach((r, i) => {
      const d = displays[i];
      if (d === "running") active += 1;
      if (r.status === "queued") {
        queued += 1;
        waits.push(now - new Date(r.createdAt).getTime());
      }
      if (r.status === "idle") queued += 1;
      if (d === "stalled" || r.status === "cancelled_stale") zombies += 1;
    });
    waits.sort((a, b) => a - b);
    const median = waits.length
      ? waits.length % 2
        ? waits[(waits.length - 1) / 2]
        : (waits[waits.length / 2 - 1] + waits[waits.length / 2]) / 2
      : null;
    return { active, queued, zombies, medianWait: median };
  }, [rows, displays, now]);

  const counts = useMemo(() => {
    const c: Record<SessionFilter, number> = { all: rows.length, running: 0, queued: 0, attention: 0 };
    rows.forEach((r, i) => {
      for (const f of FILTERS) {
        if (f !== "all" && matchesFilter(f, r, displays[i])) c[f] += 1;
      }
    });
    return c;
  }, [rows, displays]);

  const visibleRows = useMemo(
    () => rows.filter((r, i) => matchesFilter(filter, r, displays[i])),
    [rows, displays, filter],
  );

  const filterOptions: SegmentOption<SessionFilter>[] = FILTERS.map((f) => ({
    value: f,
    label: `${FILTER_LABEL[f]} ${counts[f]}`,
  }));

  const actions = { cancel, retry, rerun, abort };

  return (
    <div className="mx-auto w-full min-h-dvh max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      {/* Workspace tier: subscribe to every visible project room for live updates. */}
      {!projectId && projectsQ.data?.map((p) => <RoomSub key={p.id} projectId={p.id} />)}

      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="fg-h2">Sessions</h1>
          <p className="fg-body-sm mt-1">
            {projectId ? "Agent sessions for this project." : "Agent sessions across your workspace."}
          </p>
        </div>
        {projectId ? (
          <Button
            variant="secondary"
            size="sm"
            icon="trash"
            loading={sweep.isPending}
            onClick={() => sweep.mutate(projectId)}
          >
            Sweep zombies
          </Button>
        ) : (
          <Tooltip label="Available on a project's sessions page (owner/admin).">
            <Button variant="secondary" size="sm" icon="trash" disabled>
              Sweep zombies
            </Button>
          </Tooltip>
        )}
      </header>

      {/* Headline queue stats — derived from the loaded list so they work at
          both tiers (queue-stats only returns per-device queued/running). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        <StatCard label="Active" value={String(stats.active)} />
        <StatCard label="Queued" value={String(stats.queued)} />
        <StatCard label="Zombies" value={String(stats.zombies)} tone={stats.zombies > 0 ? "alert" : "default"} />
        <StatCard
          label="Median wait"
          value={stats.medianWait == null ? "—" : formatDuration(stats.medianWait)}
        />
      </div>

      <div className="mt-6 mb-4 overflow-x-auto">
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
          title="Couldn't load sessions"
          message={formatApiError(sessionsQ.error)}
          onRetry={() => sessionsQ.refetch()}
        />
      )}

      {!sessionsQ.isLoading && !sessionsQ.isError && rows.length === 0 && (
        <EmptyState
          title="No sessions yet"
          message={
            projectId
              ? "Agent sessions for this project will appear here as the pipeline runs."
              : "Agent sessions across your projects will appear here."
          }
        />
      )}

      {!sessionsQ.isLoading && !sessionsQ.isError && rows.length > 0 && visibleRows.length === 0 && (
        <EmptyState title="Nothing here" message="No sessions match this filter." mascot={false} />
      )}

      {!sessionsQ.isLoading && !sessionsQ.isError && visibleRows.length > 0 && (
        <>
          {/* Desktop / tablet: dense table. */}
          <div className="hidden md:block">
            <Table>
              <THead>
                <TR>
                  <TH>Session</TH>
                  <TH>Issue · agent</TH>
                  <TH className="text-right">Turns</TH>
                  <TH className="text-right">Duration</TH>
                  <TH>Status</TH>
                  <TH>Pipeline</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {visibleRows.map((row) => (
                  <SessionTableRow key={row.id} row={row} now={now} actions={actions} />
                ))}
              </TBody>
            </Table>
          </div>

          {/* Mobile: stacked cards — no horizontal page scroll. */}
          <div className="space-y-2.5 md:hidden">
            {visibleRows.map((row) => (
              <SessionMobileCard key={row.id} row={row} now={now} actions={actions} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface MutationLike {
  mutate: (id: string) => void;
}
interface RowActions {
  cancel: MutationLike;
  retry: MutationLike;
  rerun: MutationLike;
  abort: MutationLike;
}

function StatCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "alert";
}) {
  return (
    <Card>
      <CardContent>
        <p className="fg-caption">{label}</p>
        <p
          className="mt-1 font-mono text-2xl font-bold"
          style={{ color: tone === "alert" ? "var(--red-600)" : "var(--fg-default)" }}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

/** Build the contextual row-action menu, choosing items by display status. */
function buildMenuItems(row: SessionRow, display: AgentSessionDisplayStatus, a: RowActions): MenuItem[] {
  const items: MenuItem[] = [];
  const isLive = display === "running" || display === "stalled";
  const isQueued = row.status === "queued" || row.status === "idle";
  const isTerminal =
    display === "completed" ||
    display === "completed_via_recovery" ||
    display === "failed" ||
    display === "cancelled_stale";

  if (isLive || isQueued) {
    items.push({ label: "Cancel", icon: "x", danger: true, onSelect: () => a.cancel.mutate(row.id) });
  }
  if (isLive || display === "idle") {
    items.push({ label: "Abort", icon: "stop", onSelect: () => a.abort.mutate(row.id) });
  }
  if ((display === "failed" || display === "cancelled_stale") && isRetryable(row)) {
    items.push({ label: "Retry", icon: "rerun", onSelect: () => a.retry.mutate(row.id) });
  }
  if (isTerminal) {
    items.push({ label: "Rerun", icon: "fork", onSelect: () => a.rerun.mutate(row.id) });
  }
  return items;
}

function RowActionsMenu({
  row,
  display,
  actions,
}: {
  row: SessionRow;
  display: AgentSessionDisplayStatus;
  actions: RowActions;
}) {
  const items = buildMenuItems(row, display, actions);
  if (items.length === 0) return <span className="fg-caption">—</span>;
  return (
    <Menu
      align="right"
      items={items}
      trigger={
        <IconButton icon="more" aria-label="Session actions" className="min-h-11 min-w-11" />
      }
    />
  );
}

/** Title + issue/agent identity shared by table + card layouts. */
function SessionIdentity({ row }: { row: SessionRow }) {
  const issueId = row.metadata?.issueId;
  const type = row.metadata?.type;
  return (
    <div className="min-w-0">
      <p className="fg-body-sm truncate text-fg">{row.title ?? "Untitled session"}</p>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {type && <MonoTag>{type}</MonoTag>}
        {issueId && <span className="fg-caption truncate">{issueId}</span>}
      </div>
    </div>
  );
}

function useRowDuration(row: SessionRow, display: AgentSessionDisplayStatus): string {
  const live = display === "running" || display === "stalled";
  const startMs = row.startedAt ? new Date(row.startedAt).getTime() : undefined;
  const elapsed = useElapsed(startMs, live);
  if (!startMs) return "—";
  if (live) return elapsed;
  return formatDuration(new Date(row.updatedAt).getTime() - startMs);
}

function SessionTableRow({ row, now, actions }: { row: SessionRow; now: number; actions: RowActions }) {
  const display = deriveSessionDisplayStatus(row, now);
  const duration = useRowDuration(row, display);
  const stage = deriveStage(row.metadata);
  return (
    <TR>
      <TD>
        <MonoTag hue="cobalt">{row.id.slice(0, 8)}</MonoTag>
      </TD>
      <TD className="max-w-[260px]">
        <SessionIdentity row={row} />
      </TD>
      <TD className="text-right font-mono text-muted">{row.usage?.turns ?? "—"}</TD>
      <TD className="text-right font-mono text-muted">{duration}</TD>
      <TD>
        <StatusChip status={statusToChip(display)} stage={stage} />
      </TD>
      <TD>
        <PipelineTracker stage={stage} status={statusToRun(display)} variant="mini" />
      </TD>
      <TD className="text-right">
        <RowActionsMenu row={row} display={display} actions={actions} />
      </TD>
    </TR>
  );
}

function SessionMobileCard({ row, now, actions }: { row: SessionRow; now: number; actions: RowActions }) {
  const display = deriveSessionDisplayStatus(row, now);
  const duration = useRowDuration(row, display);
  const stage = deriveStage(row.metadata);
  return (
    <Card>
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <SessionIdentity row={row} />
          <RowActionsMenu row={row} display={display} actions={actions} />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <StatusChip status={statusToChip(display)} stage={stage} size="sm" />
          <div className="flex items-center gap-3">
            <Badge tone="neutral">{row.usage?.turns ?? 0} turns</Badge>
            <span className="fg-caption font-mono">{duration}</span>
          </div>
        </div>
        <div className="mt-3">
          <PipelineTracker stage={stage} status={statusToRun(display)} variant="mini" />
        </div>
      </CardContent>
    </Card>
  );
}
