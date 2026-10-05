"use client";

// A project's Sessions index under the Agents shell (ISS-291). Rows link to the
// session detail (`/projects/:slug/agents/:id`) and back to their issue (ISS-331).
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
  Pagination,
  PageTitle,
  SegmentedControl,
  SessionRowSkeleton,
  StatusChip,
  Table,
  TBody,
  TD,
  TH,
  THead,
  Tooltip,
  TR,
  type MenuItem,
  type SegmentOption,
  useElapsed,
} from "@/design";
import { useProject } from "@/features/projects/hooks";
import { IssueRefBadge } from "@/features/issues/components/issue-ref-badge";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { SESSIONS_PAGE_SIZE } from "../api";
import { FleetStrip } from "./fleet-strip";
import {
  useAbortSession,
  useCancelSession,
  useRerunSession,
  useRetrySession,
  useSessions,
  useStuckRuns,
  useSweepZombies,
} from "../hooks";
import {
  type StuckRuns,
  deriveLiveness,
  deriveSessionDisplayStatus,
  sessionStep,
  isAwaitingReply,
  isRetryable,
  sessionKind,
  statusToChip,
  classifySessionOutcome,
  isRealFailure,
  failureReasonLabel,
  formatCost,
  formatDuration,
  formatShortTime,
  AGENT_SESSION_KINDS,
  SESSION_KIND_LABEL,
  type AgentSessionDisplayStatus,
  type AgentSessionKind,
  type SessionFilter,
  type SessionRow,
} from "../types";
import { orderByOwner, OWNER_INDENT_PX } from "./session-tree";


/** `m ss` / `s` countdown for the reap-window label. */
function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

// ISS-664 — "waiting" leads the tab order: it's the one the owner scans for
// first ("who needs me"), distinct from `attention` (genuine job failures).
const FILTERS: SessionFilter[] = ["all", "waiting", "running", "queued", "attention"];
const FILTER_LABEL: Record<SessionFilter, string> = {
  all: "All",
  waiting: "Waiting for me",
  running: "Running",
  queued: "Queued",
  attention: "Attention",
};

// ISS-465 — kind dimension on top of the status filter. Defaults to "all" so
// existing readers see the same set. The row states its species, so each one
// is its own tab.
type KindFilter = "all" | AgentSessionKind;
const KIND_FILTERS: KindFilter[] = ["all", ...AGENT_SESSION_KINDS];
const KIND_LABEL: Record<KindFilter, string> = {
  all: "All kinds",
  ...SESSION_KIND_LABEL,
};

function matchesKind(kind: KindFilter, row: SessionRow): boolean {
  return kind === "all" || sessionKind(row) === kind;
}

function matchesFilter(filter: SessionFilter, row: SessionRow, display: AgentSessionDisplayStatus): boolean {
  switch (filter) {
    case "waiting":
      // ISS-664 — a finished interactive chat awaiting the owner's reply.
      // Deliberately distinct from `queued` (a pipeline session awaiting a
      // runner also carries `status:'idle'` in some capacity-blocked states,
      // but `isAwaitingReply` only matches interactive chats).
      return isAwaitingReply(row);
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

export function SessionsScreen({ projectId }: { projectId: string }) {
  // Counts and tabs are computed over one page of the newest sessions; the pager and its caption
  // say which page, so a tab never claims to cover sessions it was not given.
  const [page, setPage] = useState(1);
  const sessionsQ = useSessions({ projectId, page });
  const stuck = useStuckRuns(projectId);
  const total = sessionsQ.data?.totalCount ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / SESSIONS_PAGE_SIZE));
  const [filter, setFilter] = useState<SessionFilter>("all");
  // ISS-465 — kind dimension (Runs vs Chats); presentation-only.
  const [kind, setKind] = useState<KindFilter>("all");

  // A device id resolves to its name through the project's pool; an unknown id renders as a short MonoTag.
  const projectDetailQ = useProject(projectId);
  const slug = projectDetailQ.data?.slug;
  const deviceNameById = useMemo(
    () => new Map((projectDetailQ.data?.devicePool ?? []).map((d) => [d.id, d.name] as const)),
    [projectDetailQ.data],
  );

  // The event-router invalidates ['agent-sessions'] on this room's events.
  useRoom(projectRoom(projectId));

  const cancel = useCancelSession();
  const retry = useRetrySession();
  const rerun = useRerunSession();
  const abort = useAbortSession();
  const sweep = useSweepZombies();

  // ISS-465 — kind counts come from the page before the kind filter.
  const kindRows = useMemo(() => sessionsQ.data?.items ?? [], [sessionsQ.data]);
  const rows = useMemo(() => kindRows.filter((r) => matchesKind(kind, r)), [kindRows, kind]);

  const now = Date.now();
  const displays = useMemo(
    () => rows.map((r) => deriveSessionDisplayStatus(r, stuck)),
    [rows, stuck],
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
    const c: Record<SessionFilter, number> = {
      all: rows.length,
      waiting: 0,
      running: 0,
      queued: 0,
      attention: 0,
    };
    rows.forEach((r, i) => {
      for (const f of FILTERS) {
        if (f !== "all" && matchesFilter(f, r, displays[i])) c[f] += 1;
      }
    });
    return c;
  }, [rows, displays]);

  const visibleRows = useMemo(() => {
    return rows
      .map((r, i) => ({ row: r, display: displays[i] }))
      .filter(({ row, display }) => matchesFilter(filter, row, display))
      .map(({ row }) => row);
  }, [rows, displays, filter]);

  // A pure derivation so it can be tested without a browser; session-tree.ts
  // says what happens to a row whose owner a filter excluded.
  const treeRows = useMemo(() => orderByOwner(visibleRows), [visibleRows]);

  const filterOptions: SegmentOption<SessionFilter>[] = FILTERS.map((f) => ({
    value: f,
    label: `${FILTER_LABEL[f]} ${counts[f]}`,
  }));

  const kindCounts: Record<KindFilter, number> = {
    all: kindRows.length,
    master: 0,
    run_session: 0,
    pipeline: 0,
    chat: 0,
  };
  for (const r of kindRows) kindCounts[sessionKind(r)] += 1;
  const kindOptions: SegmentOption<KindFilter>[] = KIND_FILTERS.map((k) => ({
    value: k,
    label: `${KIND_LABEL[k]} ${kindCounts[k]}`,
  }));

  const actions = { cancel, retry, rerun, abort };

  return (
    <PageContainer className="min-h-dvh">
      {/* Compact header (ISS-391): title + the four headline metrics collapsed
          into a single inline summary strip (was a 4-card grid that ate a tall
          band of mostly 0/— on quiet projects), with Sweep on the same row. */}
      <header className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
          <PageTitle className="fg-h2">Sessions</PageTitle>
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
        <Button
          variant="secondary"
          size="sm"
          icon="trash"
          loading={sweep.isPending}
          onClick={() => sweep.mutate(projectId)}
        >
          Sweep zombies
        </Button>
      </header>

      {/* Fleet-runner rollup (ISS-378) — per-device chips + the no-runner banner. */}
      <div className="mb-4">
        <FleetStrip projectId={projectId} rows={rows} displays={displays} now={now} stuck={stuck} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 overflow-x-auto">
        <SegmentedControl options={kindOptions} value={kind} onChange={setKind} />
        <SegmentedControl options={filterOptions} value={filter} onChange={setFilter} />
        {total > 0 && (
          <div className="ml-auto flex items-center gap-2 whitespace-nowrap">
            <span className="fg-caption text-subtle">
              Counts cover sessions {(page - 1) * SESSIONS_PAGE_SIZE + 1}–
              {Math.min(page * SESSIONS_PAGE_SIZE, total)} of {total}, newest first
            </span>
            {pageCount > 1 && <Pagination page={page} pageCount={pageCount} onChange={setPage} />}
          </div>
        )}
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
          message="Agent sessions for this project will appear here as the pipeline runs."
        />
      )}

      {!sessionsQ.isLoading && !sessionsQ.isError && rows.length > 0 && visibleRows.length === 0 && (
        // ISS-664 — the "waiting for me" tab reads distinctly from a plain
        // filtered-empty ("nothing matches"): being empty here is a good
        // outcome (caught up), not a dead end.
        <EmptyState
          title={filter === "waiting" ? "You're all caught up" : "Nothing here"}
          message={
            filter === "waiting"
              ? "No conversations are waiting on your reply right now."
              : "No sessions match this filter."
          }
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
                {treeRows.map(({ row, depth, hasChildren }) => (
                  <SessionTableRow
                    key={row.id}
                    row={row}
                    depth={depth}
                    hasChildren={hasChildren}
                    slug={slug}
                    deviceName={row.deviceId ? deviceNameById.get(row.deviceId) : undefined}
                    now={now}
                    stuck={stuck}
                    actions={actions}
                  />
                ))}
              </TBody>
            </Table>
          </div>

          {/* Mobile: stacked cards — no horizontal page scroll. */}
          <div className="space-y-2.5 md:hidden">
            {treeRows.map(({ row, depth }) => (
              <SessionMobileCard
                key={row.id}
                row={row}
                depth={depth}
                slug={slug}
                deviceName={row.deviceId ? deviceNameById.get(row.deviceId) : undefined}
                now={now}
                stuck={stuck}
                actions={actions}
              />
            ))}
          </div>
        </>
      )}
    </PageContainer>
  );
}

interface RowProps {
  row: SessionRow;
  slug?: string;
  deviceName?: string;
  now: number;
  stuck: StuckRuns;
  actions: RowActions;
  /** How far under its owner this row sits, in the list as filtered. */
  depth: number;
}

/** A row's display state, its duration and the route it opens. */
function useRowView({ row, slug, stuck }: RowProps) {
  const router = useRouter();
  const display = deriveSessionDisplayStatus(row, stuck);
  const live = display === "running" || display === "stalled";
  const startMs = row.startedAt ? new Date(row.startedAt).getTime() : undefined;
  const elapsed = useElapsed(startMs, live);
  const duration = !startMs
    ? "—"
    : live
      ? elapsed
      : formatDuration(new Date(row.updatedAt).getTime() - startMs);
  const stage = sessionStep(row.metadata) ?? undefined;
  const open = slug ? () => router.push(`/projects/${slug}/agents/${row.id}`) : undefined;
  return { display, duration, stage, open };
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

function buildMenuItems(row: SessionRow, display: AgentSessionDisplayStatus, a: RowActions): MenuItem[] {
  const items: MenuItem[] = [];
  const isLive = display === "running" || display === "stalled";
  const isQueued = row.status === "queued" || row.status === "idle";
  const isTerminal =
    display === "completed" ||
    display === "completed_via_recovery" ||
    display === "failed" ||
    display === "cancelled_stale" ||
    display === "cancelled";

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
    items.push({ label: "Rerun", icon: "rerun", onSelect: () => a.rerun.mutate(row.id) });
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
  stuck,
}: {
  row: SessionRow;
  deviceName?: string;
  display: AgentSessionDisplayStatus;
  now: number;
  stuck: StuckRuns;
}) {
  if (!row.deviceId) return <span className="fg-caption text-subtle">—</span>;
  const live = display === "running" || display === "stalled";
  const liveness = live ? deriveLiveness(row, stuck, now) : null;
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

function StatusCell({
  row,
  display,
  stage,
  now,
  stuck,
}: {
  row: SessionRow;
  display: AgentSessionDisplayStatus;
  stage: string | undefined;
  now: number;
  stuck: StuckRuns;
}) {
  const liveness = deriveLiveness(row, stuck, now);
  // ISS-664 — a finished interactive chat awaiting the owner's reply gets its
  // own distinct chip (the `waiting` StatusKey — amber "a human must act"),
  // taking priority over the generic idle→paused mapping used everywhere else
  // (ChatScreen/SessionScreen keep that mapping unchanged; this is list-only).
  const awaitingReply = isAwaitingReply(row);
  const outcome = classifySessionOutcome(display, row.failureReason);
  const chipStatus = awaitingReply
    ? "waiting"
    : outcome.bucket === "active"
      ? statusToChip(display)
      : outcome.statusKey;
  const reason = failureReasonLabel(row.failureReason) ?? row.failureReason ?? null;
  const showReason =
    !!reason && (display === "failed" || display === "stalled" || display === "cancelled_stale");
  const subLine = showReason ? reason : display === "cancelled" ? outcome.label : null;
  // Red reason text only for a genuine failure; swept/cleanup reads subtle.
  const reasonColor = outcome.bucket === "failed" ? "var(--amberw-600)" : "var(--fg-subtle)";
  return (
    <div className="flex flex-col items-start gap-1">
      {!awaitingReply && outcome.tooltip ? (
        <Tooltip label={outcome.tooltip}>
          <StatusChip status={chipStatus} stage={stage} domain="session" />
        </Tooltip>
      ) : (
        <StatusChip status={chipStatus} stage={stage} domain="session" />
      )}
      {subLine && (
        <span className="fg-caption" style={{ color: reasonColor }}>
          {subLine}
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

function SessionTableRow(props: RowProps & {
  /** Whether anything in this list is owned by it. */
  hasChildren: boolean;
}) {
  const { row, slug, deviceName, now, stuck, actions, depth, hasChildren } = props;
  const { display, duration, stage, open } = useRowView(props);
  return (
    <TR>
      <TD>
        <div
          className="flex items-center gap-1.5"
          style={depth > 0 ? { paddingLeft: depth * OWNER_INDENT_PX } : undefined}
        >
          {depth > 0 && (
            <span aria-hidden className="text-muted select-none">
              &#8735;
            </span>
          )}
          {open ? (
            <button type="button" onClick={open} className="focus-visible:outline-none">
              <MonoTag hue="cobalt">{row.id.slice(0, 8)}</MonoTag>
            </button>
          ) : (
            <MonoTag hue="cobalt">{row.id.slice(0, 8)}</MonoTag>
          )}
          <SessionKindTag row={row} />
          {hasChildren && (
            <span className="text-11 text-muted" title="this session owns others in this list">
              &#8226;
            </span>
          )}
        </div>
      </TD>
      <TD className="max-w-[260px]">
        <SessionIdentity row={row} slug={slug} onOpen={open} />
      </TD>
      <TD className="max-w-[160px]">
        <RunnerCell row={row} deviceName={deviceName} display={display} now={now} stuck={stuck} />
      </TD>
      <TD className="whitespace-nowrap font-mono text-muted">{formatShortTime(row.startedAt ?? row.dispatchedAt)}</TD>
      <TD className="text-right font-mono text-muted">{row.usage?.turns ?? "—"}</TD>
      <TD className="text-right font-mono text-muted">{duration}</TD>
      <TD className="text-right font-mono text-muted">{formatCost(row.estimatedCost)}</TD>
      <TD>
        <StatusCell row={row} display={display} stage={stage} now={now} stuck={stuck} />
      </TD>
      <TD className="text-right">
        <RowActionsMenu row={row} display={display} actions={actions} />
      </TD>
    </TR>
  );
}

/** What species the row says it is: one word per kind, four of them. */
const KIND_TONE = {
  master: "accent",
  run_session: "cobalt",
  pipeline: "neutral",
  chat: "neutral",
} as const satisfies Record<AgentSessionKind, "neutral" | "accent" | "cobalt">;

function SessionKindTag({ row }: { row: SessionRow }) {
  const kind = sessionKind(row);
  return <Badge tone={KIND_TONE[kind]}>{SESSION_KIND_LABEL[kind]}</Badge>;
}

function SessionMobileCard(props: RowProps) {
  const { row, slug, deviceName, now, stuck, actions, depth } = props;
  const { display, duration, stage, open } = useRowView(props);
  return (
    // The same edge the table shows, at a width a phone can carry: the nesting
    // has to survive the narrow layout or the tree is a desktop-only claim.
    <Card>
      <CardContent>
        <div
          className="flex items-start justify-between gap-3"
          style={depth > 0 ? { paddingLeft: depth * OWNER_INDENT_PX } : undefined}
        >
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-1.5">
              {depth > 0 && (
                <span aria-hidden className="text-muted select-none">
                  &#8735;
                </span>
              )}
              <SessionKindTag row={row} />
            </div>
            <SessionIdentity row={row} slug={slug} onOpen={open} />
          </div>
          <RowActionsMenu row={row} display={display} actions={actions} />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <StatusCell row={row} display={display} stage={stage} now={now} stuck={stuck} />
          <div className="flex items-center gap-3">
            <Badge tone="neutral">{row.usage?.turns ?? 0} turns</Badge>
            <span className="fg-mono text-muted">{duration}</span>
            <span className="fg-mono text-muted">{formatCost(row.estimatedCost)}</span>
          </div>
        </div>
        <div className="fg-caption mt-1.5 text-subtle">Started {formatShortTime(row.startedAt ?? row.dispatchedAt)}</div>
        {row.deviceId && (
          <div className="mt-2.5">
            <RunnerCell row={row} deviceName={deviceName} display={display} now={now} stuck={stuck} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
