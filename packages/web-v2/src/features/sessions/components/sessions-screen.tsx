"use client";

// web-v2 shared Sessions index — used at BOTH the workspace tier
// (`/v2/sessions`, cross-project, no `scope.projectId`) and the project tier
// (under the Agents shell, scoped + Sweep zombies). ISS-291. Rows link to the
// session detail (`/projects/:slug/agents/:id`) and back to their issue
// (ISS-331); the project slug is resolved per row from the projects list.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  HealthDot,
  Icon,
  IconButton,
  Menu,
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
  Tooltip,
  useElapsed,
  type MenuItem,
  type SegmentOption,
} from "@/design";
import { useProject, useProjects } from "@/features/projects/hooks";
import { useDevices } from "@/features/runners/hooks";
import { IssueRefBadge } from "@/features/issues/components/issue-ref-badge";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { FleetStrip } from "./fleet-strip";
import {
  useAbortSession,
  useCancelSession,
  useRerunSession,
  useRetrySession,
  useSessions,
  useSweepZombies,
} from "../hooks";
import {
  deriveLiveness,
  deriveSessionDisplayStatus,
  deriveStage,
  isRetryable,
  sessionKind,
  statusToChip,
  FAILURE_REASON_LABEL,
  type AgentSessionDisplayStatus,
  type SessionFilter,
  type SessionRow,
} from "../types";

interface SessionsScreenProps {
  /** Project-tier scope. Omit for the cross-project workspace tier.
   *  `issueId` (when set) filters the list to one issue's sessions — used by
   *  the issue-detail "Open sessions" deep-link (`?issue=<uuid>`). */
  scope?: { projectId?: string; issueId?: string };
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

/** `m ss` / `s` countdown for the reap-window label. */
function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
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
  const issueFilter = scope?.issueId;
  const sessionsQ = useSessions({ projectId });
  const projectsQ = useProjects();
  const [filter, setFilter] = useState<SessionFilter>("all");

  // Resolve each row's project slug (id → slug) so session rows can link to the
  // project-scoped detail + issue routes at both tiers.
  const slugById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projectsQ.data ?? []) m.set(p.id, p.slug);
    return m;
  }, [projectsQ.data]);
  const slugFor = (row: SessionRow) => slugById.get(row.projectId);

  // Resolve a device id → friendly name so each row can show WHERE it ran.
  // Project tier: the project's devicePool (project-scoped). Workspace tier:
  // fall back to the caller's owner-scoped device list. Unknown ids render as
  // a short MonoTag (different owner's device).
  const projectDetailQ = useProject(projectId);
  const devicesQ = useDevices();
  const deviceNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of projectDetailQ.data?.devicePool ?? []) m.set(d.id, d.name);
    for (const d of devicesQ.data ?? []) if (!m.has(d.id)) m.set(d.id, d.name);
    return m;
  }, [projectDetailQ.data, devicesQ.data]);

  // Live updates: project tier subscribes to its room; workspace tier fans out
  // across every visible project. The event-router invalidates ['agent-sessions'].
  useRoom(projectId ? projectRoom(projectId) : null);

  const cancel = useCancelSession();
  const retry = useRetrySession();
  const rerun = useRerunSession();
  const abort = useAbortSession();
  const sweep = useSweepZombies();

  const rows = useMemo(() => {
    const all = sessionsQ.data?.items ?? [];
    return issueFilter ? all.filter((r) => r.metadata?.issueId === issueFilter) : all;
  }, [sessionsQ.data, issueFilter]);

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
      if (r.status === "queued" || r.status === "idle") {
        queued += 1;
        // Time a still-queued session has been waiting for a runner.
        const since = r.dispatchedAt ?? r.createdAt;
        const ms = since ? now - new Date(since).getTime() : NaN;
        if (Number.isFinite(ms) && ms >= 0) waits.push(ms);
      }
      if (d === "stalled" || r.status === "cancelled_stale") zombies += 1;
    });
    // Median wait across queued sessions (draft "Median wait" metric).
    let medianWaitMs = 0;
    if (waits.length > 0) {
      waits.sort((a, b) => a - b);
      const mid = Math.floor(waits.length / 2);
      medianWaitMs = waits.length % 2 ? waits[mid] : Math.round((waits[mid - 1] + waits[mid]) / 2);
    }
    return { active, queued, zombies, medianWaitMs };
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
    <PageContainer width="wide" className="min-h-dvh">
      {/* Workspace tier: subscribe to every visible project room for live updates. */}
      {!projectId && projectsQ.data?.map((p) => <RoomSub key={p.id} projectId={p.id} />)}

      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="fg-h2">Sessions</h1>
          <p className="fg-body-sm mt-1">
            {issueFilter
              ? "Agent sessions for this issue."
              : projectId
                ? "Agent sessions for this project."
                : "Agent sessions across your workspace."}
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

      {/* Fleet-runner rollup (ISS-378) — per-device chips + the no-runner
          banner. Project tier only (needs a project-scoped device pool +
          queue-stats); the workspace tier keeps the aggregate summary alone. */}
      {projectId && (
        <div className="mb-4">
          <FleetStrip projectId={projectId} rows={rows} displays={displays} now={now} />
        </div>
      )}

      {/* Headline queue stats (draft "q-strip") — derived from the loaded list
          so they work at both tiers (queue-stats only returns per-device
          queued/running). Active · Queued · Zombie jobs · Median wait. Kept as a
          compact summary beneath the fleet strip. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        <StatCard label="Active" value={String(stats.active)} />
        <StatCard label="Queued" value={String(stats.queued)} />
        <StatCard label="Zombie jobs" value={String(stats.zombies)} tone={stats.zombies > 0 ? "alert" : "default"} />
        <StatCard label="Median wait" value={stats.queued > 0 ? formatDuration(stats.medianWaitMs) : "—"} />
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
                  <TH>Runner</TH>
                  <TH className="text-right">Turns</TH>
                  <TH className="text-right">Duration</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {visibleRows.map((row) => (
                  <SessionTableRow
                    key={row.id}
                    row={row}
                    slug={slugFor(row)}
                    deviceName={row.deviceId ? deviceNameById.get(row.deviceId) : undefined}
                    now={now}
                    actions={actions}
                  />
                ))}
              </TBody>
            </Table>
          </div>

          {/* Mobile: stacked cards — no horizontal page scroll. */}
          <div className="space-y-2.5 md:hidden">
            {visibleRows.map((row) => (
              <SessionMobileCard
                key={row.id}
                row={row}
                slug={slugFor(row)}
                deviceName={row.deviceId ? deviceNameById.get(row.deviceId) : undefined}
                now={now}
                actions={actions}
              />
            ))}
          </div>
        </>
      )}
    </PageContainer>
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
        <p className="fg-overline">{label}</p>
        <p
          className="fg-h1 mt-1 tabular-nums"
          style={tone === "alert" ? { color: "var(--color-red)" } : undefined}
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

/** Title + issue/agent identity shared by table + card layouts. The title
 *  opens the session detail (when a slug is resolvable); the issue tag links
 *  back to the issue. */
function SessionIdentity({
  row,
  slug,
  onOpen,
}: {
  row: SessionRow;
  slug?: string;
  onOpen?: () => void;
}) {
  const router = useRouter();
  const issueId = row.metadata?.issueId;
  const kind = sessionKind(row);
  const title = row.title ?? "Untitled session";
  return (
    <div className="min-w-0">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="block w-full text-left focus-visible:outline-none"
        >
          <span className="fg-body-sm block truncate text-fg hover:text-accent-text">{title}</span>
        </button>
      ) : (
        <p className="fg-body-sm truncate text-fg">{title}</p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {/* Pipeline (job-driven) vs interactive chat — a running chat spawns no
            job, so it is NOT a wedged runner (ISS-378 AC#4). */}
        <Tooltip
          label={
            kind === "chat"
              ? "Interactive chat — spawns no pipeline job, so a running chat is not a wedged runner."
              : "Pipeline session — driven by a pipeline job on a runner."
          }
        >
          <MonoTag hue={kind === "chat" ? "flame" : "cobalt"}>{kind}</MonoTag>
        </Tooltip>
        {issueId &&
          (slug ? (
            <IssueRefBadge id={issueId} slug={slug} />
          ) : (
            <span className="fg-caption truncate">{issueId}</span>
          ))}
        {/* Jump to the pipeline-run timeline (ISS-378 AC#3). */}
        {row.pipelineRunId && (
          <Tooltip label="Open pipeline run timeline">
            <button
              type="button"
              onClick={() => router.push(`/ops?run=${row.pipelineRunId}`)}
              className="inline-flex items-center gap-1 focus-visible:outline-none"
            >
              <MonoTag hue="neutral">
                <Icon name="pipeline" size={11} className="-mt-px inline" /> run
              </MonoTag>
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

/** Runner/device cell: friendly name (or short id for an unknown owner's
 *  device) + a shared-threshold alive/stale dot for live sessions. */
function RunnerCell({
  row,
  deviceName,
  display,
  now,
}: {
  row: SessionRow;
  deviceName?: string;
  display: AgentSessionDisplayStatus;
  now: number;
}) {
  if (!row.deviceId) return <span className="fg-caption text-subtle">—</span>;
  const live = display === "running" || display === "stalled";
  const liveness = live ? deriveLiveness(row, now) : null;
  const health =
    liveness?.state === "stale" || liveness?.state === "reaping"
      ? "attention"
      : liveness?.state === "alive"
        ? "healthy"
        : null;
  return (
    <div className="flex items-center gap-1.5 overflow-hidden">
      {health && <HealthDot health={health} withLabel={false} />}
      {deviceName ? (
        <span className="truncate fg-body-sm text-muted" title={deviceName}>
          {deviceName}
        </span>
      ) : (
        <MonoTag hue="neutral">{row.deviceId.slice(0, 8)}</MonoTag>
      )}
    </div>
  );
}

/** Concrete failure reason + (for live stalled rows) a countdown to the server
 *  auto-reap, so "stalled (display)" never reads as "already reaped (server)". */
function StatusCell({
  row,
  display,
  stage,
  now,
}: {
  row: SessionRow;
  display: AgentSessionDisplayStatus;
  stage: ReturnType<typeof deriveStage>;
  now: number;
}) {
  const liveness = deriveLiveness(row, now);
  const reason = row.failureReason ? FAILURE_REASON_LABEL[row.failureReason] ?? row.failureReason : null;
  const showReason =
    !!reason && (display === "failed" || display === "stalled" || display === "cancelled_stale");
  return (
    <div className="flex flex-col items-start gap-1">
      <StatusChip status={statusToChip(display)} stage={stage} domain="session" />
      {showReason && (
        <span className="fg-caption" style={{ color: "var(--amberw-600)" }}>
          {reason}
        </span>
      )}
      {liveness.state === "stale" && liveness.reapInMs != null && (
        <span className="fg-caption text-subtle" title="Time until the server auto-recovers this session">
          auto-recovers in {formatCountdown(liveness.reapInMs)}
        </span>
      )}
      {liveness.state === "reaping" && (
        <span className="fg-caption text-subtle">awaiting auto-recovery…</span>
      )}
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

function SessionTableRow({
  row,
  slug,
  deviceName,
  now,
  actions,
}: {
  row: SessionRow;
  slug?: string;
  deviceName?: string;
  now: number;
  actions: RowActions;
}) {
  const router = useRouter();
  const display = deriveSessionDisplayStatus(row, now);
  const duration = useRowDuration(row, display);
  const stage = deriveStage(row.metadata);
  const open = slug ? () => router.push(`/projects/${slug}/agents/${row.id}`) : undefined;
  return (
    <TR>
      <TD>
        {open ? (
          <button type="button" onClick={open} className="focus-visible:outline-none">
            <MonoTag hue="cobalt">{row.id.slice(0, 8)}</MonoTag>
          </button>
        ) : (
          <MonoTag hue="cobalt">{row.id.slice(0, 8)}</MonoTag>
        )}
      </TD>
      <TD className="max-w-[260px]">
        <SessionIdentity row={row} slug={slug} onOpen={open} />
      </TD>
      <TD className="max-w-[160px]">
        <RunnerCell row={row} deviceName={deviceName} display={display} now={now} />
      </TD>
      <TD className="text-right font-mono text-muted">{row.usage?.turns ?? "—"}</TD>
      <TD className="text-right font-mono text-muted">{duration}</TD>
      <TD>
        <StatusCell row={row} display={display} stage={stage} now={now} />
      </TD>
      <TD className="text-right">
        <RowActionsMenu row={row} display={display} actions={actions} />
      </TD>
    </TR>
  );
}

function SessionMobileCard({
  row,
  slug,
  deviceName,
  now,
  actions,
}: {
  row: SessionRow;
  slug?: string;
  deviceName?: string;
  now: number;
  actions: RowActions;
}) {
  const router = useRouter();
  const display = deriveSessionDisplayStatus(row, now);
  const duration = useRowDuration(row, display);
  const stage = deriveStage(row.metadata);
  const open = slug ? () => router.push(`/projects/${slug}/agents/${row.id}`) : undefined;
  return (
    <Card>
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <SessionIdentity row={row} slug={slug} onOpen={open} />
          <RowActionsMenu row={row} display={display} actions={actions} />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <StatusCell row={row} display={display} stage={stage} now={now} />
          <div className="flex items-center gap-3">
            <Badge tone="neutral">{row.usage?.turns ?? 0} turns</Badge>
            <span className="fg-mono text-muted">{duration}</span>
          </div>
        </div>
        {row.deviceId && (
          <div className="mt-2.5">
            <RunnerCell row={row} deviceName={deviceName} display={display} now={now} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
