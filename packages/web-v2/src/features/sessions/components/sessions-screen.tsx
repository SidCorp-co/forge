"use client";

// web-v2 shared Sessions index — used at BOTH the workspace tier
// (`/sessions`, cross-project, no `scope.projectId`) and the project tier
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
  classifySessionOutcome,
  isRealFailure,
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

/** Short absolute timestamp for the Started column, or "—" when absent/invalid.
 *  Mirrors the context-rail detail formatter (ISS-391). */
function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** USD cost — sub-cent precision for tiny sessions, 2dp otherwise; "—" when
 *  the row carries no cost rollup (older payloads). Mirrors context-rail. */
function fmtCost(usd: number | undefined): string {
  if (usd == null) return "—";
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

const FILTERS: SessionFilter[] = ["all", "running", "queued", "attention"];
const FILTER_LABEL: Record<SessionFilter, string> = {
  all: "All",
  running: "Running",
  queued: "Queued",
  attention: "Attention",
};

// ISS-465 — kind dimension on top of the status filter. Defaults to "all" so
// existing readers see the same set; explicit "Runs" / "Chats" labels separate
// pipeline/pm sessions from interactive chats (already discriminated server-
// side by metadata.type, here just presentation).
type KindFilter = "all" | "runs" | "chats";
const KIND_FILTERS: KindFilter[] = ["all", "runs", "chats"];
const KIND_LABEL: Record<KindFilter, string> = {
  all: "All kinds",
  runs: "Runs",
  chats: "Chats",
};

function matchesKind(kind: KindFilter, row: SessionRow): boolean {
  if (kind === "all") return true;
  const k = sessionKind(row);
  return kind === "runs" ? k === "pipeline" : k === "chat";
}

function matchesFilter(filter: SessionFilter, row: SessionRow, display: AgentSessionDisplayStatus): boolean {
  switch (filter) {
    case "running":
      return display === "running" || display === "stalled";
    case "queued":
      return row.status === "queued" || row.status === "idle";
    case "attention":
      // ISS-322 — only GENUINE failures + live-stalled (about-to-be-reaped)
      // sessions need attention. A terminal `cancelled_stale`/lifecycle cancel
      // is benign cleanup (`swept`), so it no longer lands here.
      return isRealFailure(display, row.failureReason) || display === "stalled";
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
  // ISS-465 — kind dimension (Runs vs Chats); presentation-only.
  const [kind, setKind] = useState<KindFilter>("all");

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
    const issueFiltered = issueFilter ? all.filter((r) => r.metadata?.issueId === issueFilter) : all;
    // ISS-465 — kind dimension applies BEFORE the status filter so the status
    // counts reflect the chosen kind ("3 Running chats" vs "3 Running runs").
    return issueFiltered.filter((r) => matchesKind(kind, r));
  }, [sessionsQ.data, issueFilter, kind]);

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
      // ISS-322 — "Zombie jobs" counts only LIVE stalled sessions (heartbeat
      // overdue, pending auto-recovery). A terminal `cancelled_stale` is benign
      // swept cleanup and no longer inflates this alert.
      if (d === "stalled") zombies += 1;
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

  // ISS-465 — kind dimension; counts come from the unfiltered (issue-scoped)
  // set so switching tabs shows the true population in each.
  const kindRows = useMemo(() => {
    const all = sessionsQ.data?.items ?? [];
    return issueFilter ? all.filter((r) => r.metadata?.issueId === issueFilter) : all;
  }, [sessionsQ.data, issueFilter]);
  const kindCounts: Record<KindFilter, number> = {
    all: kindRows.length,
    runs: 0,
    chats: 0,
  };
  for (const r of kindRows) {
    const k = sessionKind(r);
    if (k === "pipeline") kindCounts.runs += 1;
    else kindCounts.chats += 1;
  }
  const kindOptions: SegmentOption<KindFilter>[] = KIND_FILTERS.map((k) => ({
    value: k,
    label: `${KIND_LABEL[k]} ${kindCounts[k]}`,
  }));

  const actions = { cancel, retry, rerun, abort };

  return (
    <PageContainer width="wide" className="min-h-dvh">
      {/* Workspace tier: subscribe to every visible project room for live updates. */}
      {!projectId && projectsQ.data?.map((p) => <RoomSub key={p.id} projectId={p.id} />)}

      {/* Compact header (ISS-391): title + the four headline metrics collapsed
          into a single inline summary strip (was a 4-card grid that ate a tall
          band of mostly 0/— on quiet projects), with Sweep on the same row. */}
      <header className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
          <h1 className="fg-h2">Sessions</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatPill label="Active" value={String(stats.active)} />
            <StatPill label="Queued" value={String(stats.queued)} />
            <StatPill
              label="Zombie jobs"
              value={String(stats.zombies)}
              tone={stats.zombies > 0 ? "alert" : "default"}
            />
            <StatPill
              label="Median wait"
              value={stats.queued > 0 ? formatDuration(stats.medianWaitMs) : "—"}
            />
          </div>
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

      <div className="mb-4 flex flex-wrap gap-3 overflow-x-auto">
        <SegmentedControl options={kindOptions} value={kind} onChange={setKind} />
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
                  <TH>Started</TH>
                  <TH className="text-right">Turns</TH>
                  <TH className="text-right">Duration</TH>
                  <TH className="text-right">Cost</TH>
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

/** Compact inline metric (ISS-391) — replaces the old big-number StatCard grid.
 *  `label: value` on one line; the value turns red in `alert` tone (e.g. zombie
 *  jobs > 0). */
function StatPill({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "alert";
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="fg-overline">{label}</span>
      <span
        className="fg-body-sm font-semibold tabular-nums"
        style={tone === "alert" ? { color: "var(--color-red)" } : undefined}
      >
        {value}
      </span>
    </span>
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
  // ISS-322 — classify terminal sessions so benign cleanup / lifecycle cancels
  // render with the neutral `swept` token (NOT red), with an explanatory
  // tooltip. Genuine failures keep the red `failed` token + amber reason.
  const outcome = classifySessionOutcome(display, row.failureReason);
  const chipStatus = outcome.bucket === "active" ? statusToChip(display) : outcome.statusKey;
  const reason = row.failureReason ? FAILURE_REASON_LABEL[row.failureReason] ?? row.failureReason : null;
  const showReason =
    !!reason && (display === "failed" || display === "stalled" || display === "cancelled_stale");
  // Red reason text only for a genuine failure; swept/cleanup reads subtle.
  const reasonColor = outcome.bucket === "failed" ? "var(--amberw-600)" : "var(--fg-subtle)";
  return (
    <div className="flex flex-col items-start gap-1">
      {outcome.tooltip ? (
        <Tooltip label={outcome.tooltip}>
          <StatusChip status={chipStatus} stage={stage} domain="session" />
        </Tooltip>
      ) : (
        <StatusChip status={chipStatus} stage={stage} domain="session" />
      )}
      {showReason && (
        <span className="fg-caption" style={{ color: reasonColor }}>
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
      <TD className="whitespace-nowrap font-mono text-muted">{fmtTime(row.startedAt ?? row.dispatchedAt)}</TD>
      <TD className="text-right font-mono text-muted">{row.usage?.turns ?? "—"}</TD>
      <TD className="text-right font-mono text-muted">{duration}</TD>
      <TD className="text-right font-mono text-muted">{fmtCost(row.estimatedCost)}</TD>
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
            <span className="fg-mono text-muted">{fmtCost(row.estimatedCost)}</span>
          </div>
        </div>
        <div className="fg-caption mt-1.5 text-subtle">Started {fmtTime(row.startedAt ?? row.dispatchedAt)}</div>
        {row.deviceId && (
          <div className="mt-2.5">
            <RunnerCell row={row} deviceName={deviceName} display={display} now={now} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
