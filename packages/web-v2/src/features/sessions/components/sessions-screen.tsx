"use client";

// web-v2 shared Sessions index — used at BOTH the workspace tier
// (`/sessions`, cross-project, no `scope.projectId`) and the project tier
// (under the Agents shell, scoped + End silent sessions). ISS-291. Rows link to the
// session detail (`/projects/:slug/agents/:id`) and back to their issue
// (ISS-331); the project slug is resolved per row from the projects list.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  EmptyState,
  ErrorState,
  HealthDot,
  Icon,
  IconButton,
  Menu,
  MonoTag,
  PageContainer,
  SectionTitle,
  SegmentedControl,
  SessionRowSkeleton,
  SILENCE_TONE,
  SILENCE_WORD,
  Table,
  TBody,
  TD,
  TH,
  THead,
  Tooltip,
  TR,
  type MenuItem,
  formatElapsed,
  type SegmentOption,
  WORKING_WORD,
} from "@/design";
import { TONE_META } from "@/design/status";
import { SessionChip } from "./session-chip";
import { useSessionDuration } from "../session-duration";
import { CHAT_TAG_HOVER, coreNoteText, ENDS_AS_FAILED_HOVER, leaseDisagreementText } from "../status-sentences";
import { StopSessionConfirm } from "./stop-session-confirm";
import { isWaitingForInput, sessionWord } from "../session-word";
import { useOrgScopedProjects, useProject, useProjects } from "@/features/projects/hooks";
import { useDevices } from "@/features/runners/hooks";
import { IssueRefBadge } from "@/features/issues/components/issue-ref-badge";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { EndSilentSessions } from "./end-silent-sessions";
import { FleetStrip } from "./fleet-strip";
import { SessionReplyPanel } from "./session-reply-panel";
import {
  useAbortSession,
  useCancelSession,
  useRerunSession,
  useRetrySession,
  useSessions,
} from "../hooks";
import {
  boxDotOf,
  deriveLiveness,
  isLiveDisplay,
  deriveSessionDisplayStatus,
  sessionStep,
  sessionTitle,
  isAwaitingReply,
  isInteractiveSession,
  isWaitingForABox,
  isRetryable,
  sessionKind,
  sessionChipStatusOf,
  sessionEndText,
  classifySessionOutcome,
  isRealFailure,
  failureReasonLabel,
  quietEndText,
  chatCloseText,
  AGENT_SESSION_KINDS,
  SESSION_KIND_LABEL,
  type AgentSessionDisplayStatus,
  type AgentSessionKind,
  type SessionFilter,
  type SessionRow,
} from "../types";
import { orderByOwner, OWNER_INDENT_PX } from "./session-tree";

interface SessionsScreenProps {
  /** Project-tier scope. Omit for the cross-project workspace tier.
   *  `issueId` (when set) filters the list to one issue's sessions — used by
   *  the issue-detail "Open sessions" deep-link (`?issue=<uuid>`). */
  scope?: { projectId?: string; issueId?: string };
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

// ISS-664 — "waiting" leads the tab order: it's the one the owner scans for
// first ("who needs me"), distinct from `attention` (genuine job failures).
const FILTERS: SessionFilter[] = ["all", "waiting", "running", "queued", "attention"];
const FILTER_LABEL: Record<SessionFilter, string> = {
  all: "All",
  waiting: "Waiting for me",
  running: WORKING_WORD,
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
  if (kind === "all") return true;
  return sessionKind(row) === kind;
}

function matchesFilter(
  filter: SessionFilter,
  row: SessionRow,
  display: AgentSessionDisplayStatus,
  now: number,
): boolean {
  switch (filter) {
    case "waiting":
      // A chat awaiting the owner's reply (ISS-664), and every session the Pipeline page calls
      // Waiting for input (ISS-1228): both wait on a person's next message.
      return isAwaitingReply(row) || isWaitingForInput(row, now);
    case "running": {
      // The sessions this list calls Working, which the header's Working figure counts too: never a
      // quiet one, nor one doing something it has its own word for. A chat has no session word,
      // and its chip says Working while it runs.
      const word = sessionWord(row, now);
      return word ? word.label === WORKING_WORD : display === "running";
    }
    case "queued":
      return isWaitingForABox(row);
    case "attention":
      // ISS-322 — only GENUINE failures, live-stalled (about-to-be-reaped) sessions and sessions
      // their box reports blocked need attention. A terminal `cancelled_stale`/lifecycle cancel is
      // benign cleanup (`swept`), so it no longer lands here.
      return isRealFailure(display, row.failureReason) || display === "stalled" || display === "blocked";
    default:
      return true;
  }
}

function RoomSub({ projectId }: { projectId: string }) {
  useRoom(projectRoom(projectId));
  return null;
}

export function SessionsScreen({ scope }: SessionsScreenProps) {
  const projectId = scope?.projectId;
  const issueFilter = scope?.issueId;
  const sessionsQ = useSessions({ projectId });
  const projectsQ = useProjects();
  // ISS-477 — at the workspace tier scope rows to the active org's projects. The
  // project tier (scope.projectId set) already targets one project, so leave it.
  const { projects: orgProjects, projectIds: orgProjectIds } = useOrgScopedProjects();
  const [filter, setFilter] = useState<SessionFilter>("all");
  // ISS-465 — kind dimension (Runs vs Chats); presentation-only.
  const [kind, setKind] = useState<KindFilter>("all");
  // ISS-664 — workspace-tier inline reply panel. Project tier keeps the
  // existing full route navigation (no pain point there), so this only ever
  // gets set when `projectId` is unset.
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);

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

  const rows = useMemo(() => {
    const all = sessionsQ.data?.items ?? [];
    const issueFiltered = issueFilter ? all.filter((r) => r.metadata?.issueId === issueFilter) : all;
    // ISS-477 — workspace tier: keep only sessions whose project is in the active org.
    const scoped = projectId ? issueFiltered : issueFiltered.filter((r) => orgProjectIds.has(r.projectId));
    return scoped.filter((r) => matchesKind(kind, r));
  }, [sessionsQ.data, issueFilter, kind, projectId, orgProjectIds]);

  // ISS-664 — resolve the open panel's row (and its slug) from the currently
  // loaded rows so the panel can render without a second fetch.
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r] as const)), [rows]);
  const openRow = openSessionId ? rowById.get(openSessionId) : undefined;

  const now = Date.now();
  const displays = useMemo(
    () => rows.map((r) => deriveSessionDisplayStatus(r, now)),
    [rows, now],
  );

  const stats = useMemo(() => {
    let queued = 0;
    let zombies = 0;
    const waits: number[] = [];
    rows.forEach((r, i) => {
      const d = displays[i];
      if (isWaitingForABox(r)) {
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
    return { queued, zombies, medianWaitMs };
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
        if (f !== "all" && matchesFilter(f, r, displays[i], now)) c[f] += 1;
      }
    });
    return c;
  }, [rows, displays, now]);

  const visibleRows = useMemo(() => {
    return rows
      .map((r, i) => ({ row: r, display: displays[i] }))
      .filter(({ row, display }) => matchesFilter(filter, row, display, now))
      .map(({ row }) => row);
  }, [rows, displays, filter, now]);

  // A pure derivation so it can be tested without a browser; session-tree.ts
  // says what happens to a row whose owner a filter excluded.
  const treeRows = useMemo(() => orderByOwner(visibleRows), [visibleRows]);

  const filterOptions: SegmentOption<SessionFilter>[] = FILTERS.map((f) => ({
    value: f,
    label: `${FILTER_LABEL[f]} ${counts[f]}`,
  }));

  // ISS-465 — kind dimension; counts come from the unfiltered (issue-scoped)
  // set so switching tabs shows the true population in each.
  const kindRows = useMemo(() => {
    const all = sessionsQ.data?.items ?? [];
    const issueFiltered = issueFilter ? all.filter((r) => r.metadata?.issueId === issueFilter) : all;
    return projectId ? issueFiltered : issueFiltered.filter((r) => orgProjectIds.has(r.projectId));
  }, [sessionsQ.data, issueFilter, projectId, orgProjectIds]);
  const kindCounts: Record<KindFilter, number> = {
    all: kindRows.length,
    master: 0,
    run_session: 0,
    pipeline: 0,
    pm: 0,
    chat: 0,
  };
  for (const r of kindRows) kindCounts[sessionKind(r)] += 1;
  const kindOptions: SegmentOption<KindFilter>[] = KIND_FILTERS.map((k) => ({
    value: k,
    label: `${KIND_LABEL[k]} ${kindCounts[k]}`,
  }));

  // A stop is asked about before it is made: the menu names the act, the confirmation which session.
  const [stopAsked, setStopAsked] = useState<SessionRow | null>(null);
  const askStop = { mutate: (id: string) => setStopAsked(rows.find((r) => r.id === id) ?? null) };
  const actions = { cancel: askStop, retry, rerun, abort };

  return (
    <PageContainer className="min-h-dvh">
      <StopSessionConfirm
        target={
          stopAsked
            ? {
                name: sessionTitle(stopAsked) ?? `Session ${stopAsked.id.slice(0, 8)}`,
                box: stopAsked.deviceId ? deviceNameById.get(stopAsked.deviceId) : null,
              }
            : null
        }
        loading={cancel.isPending}
        onClose={() => setStopAsked(null)}
        onConfirm={() => stopAsked && cancel.mutate(stopAsked.id, { onSuccess: () => setStopAsked(null) })}
      />
      {/* Workspace tier: subscribe to every active-org project room for live updates. */}
      {!projectId && orgProjects.map((p) => <RoomSub key={p.id} projectId={p.id} />)}

      {/* Compact header (ISS-391): title + the four headline metrics collapsed
          into a single inline summary strip (was a 4-card grid that ate a tall
          band of mostly 0/— on quiet projects), with End silent sessions on the same row. */}
      <header className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
          {/* A tab of a project's Agents page, whose title is the page's h1 (ISS-1229 r47). */}
          <SectionTitle className="fg-h2">Sessions</SectionTitle>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatPill label={WORKING_WORD} value={String(counts.running)} />
            <StatPill label="Queued" value={String(stats.queued)} />
            <StatPill
              label={SILENCE_WORD}
              value={String(stats.zombies)}
              ink={stats.zombies > 0 ? TONE_META[SILENCE_TONE].fg : undefined}
            />
            <StatPill
              label="Median wait"
              value={stats.queued > 0 ? formatElapsed(stats.medianWaitMs) : "—"}
            />
          </div>
        </div>
        <EndSilentSessions projectId={projectId ?? null} />

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
        <div className="border-y border-line">
          {SKELETON_ROWS.map((key) => (
            <SessionRowSkeleton key={key} />
          ))}
        </div>
      )}

      {sessionsQ.isError && (
        <ErrorState
          title="Couldn't load sessions"
          message={formatApiError(sessionsQ.error)}
          error={sessionsQ.error} onRetry={() => sessionsQ.refetch()}
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
          {/* Desktop / tablet: dense table. Its nine columns fit the content column at 1280: cells keep a
              12px side, and the issue column takes what the others leave, cutting its title to fit. */}
          <div className="hidden md:block">
            <Table className="[&_td]:px-3 [&_th]:px-3">
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
                    slug={slugFor(row)}
                    deviceName={row.deviceId ? deviceNameById.get(row.deviceId) : undefined}
                    now={now}
                    actions={actions}
                    projectId={projectId}
                    onInlineOpen={setOpenSessionId}
                  />
                ))}
              </TBody>
            </Table>
          </div>

          {/* Mobile: flush rows under hairlines — no horizontal page scroll, no card per session. */}
          <ul aria-label="Sessions" className="divide-y divide-line border-y border-line md:hidden">
            {treeRows.map(({ row, depth }) => (
              <SessionMobileRow
                key={row.id}
                row={row}
                depth={depth}
                slug={slugFor(row)}
                deviceName={row.deviceId ? deviceNameById.get(row.deviceId) : undefined}
                now={now}
                actions={actions}
                projectId={projectId}
                onInlineOpen={setOpenSessionId}
              />
            ))}
          </ul>
        </>
      )}

      {/* ISS-664 — workspace tier only: inline reply panel. Keeps the list
          mounted+visible behind the drawer (AC4). Project tier never sets
          `openSessionId` (its rows navigate instead), so this stays inert there. */}
      {!projectId && (
        <SessionReplyPanel
          sessionId={openSessionId}
          slug={openRow ? slugFor(openRow) : undefined}
          onClose={() => setOpenSessionId(null)}
        />
      )}
    </PageContainer>
  );
}

interface MutationLike {
  mutate: (id: string) => void;
}
/** The placeholder rows drawn while the list is read, each with a key of its own. */
const SKELETON_ROWS = ["s1", "s2", "s3", "s4", "s5", "s6"] as const;

export interface RowActions {
  cancel: MutationLike;
  retry: MutationLike;
  rerun: MutationLike;
  abort: MutationLike;
}

/** Compact inline metric (ISS-391): `label: value` on one line, the value in the ink its state takes. */
function StatPill({ label, value, ink }: { label: string; value: string; ink?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="fg-overline">{label}</span>
      <span
        className="fg-body-sm font-semibold tabular-nums"
        style={ink ? { color: ink } : undefined}
      >
        {value}
      </span>
    </span>
  );
}

/** Build the contextual row-action menu, choosing items by display status. Ending the current turn
 *  leaves the session open, so it is named for that and kept apart from Stop session, and is offered
 *  only on a chat whose turn is running: a box ends a chat's turn and nothing else (ISS-1228). */
export function buildMenuItems(row: SessionRow, display: AgentSessionDisplayStatus, a: RowActions): MenuItem[] {
  const items: MenuItem[] = [];
  const isLive = isLiveDisplay(display);
  const isQueued = row.status === "queued" || row.status === "idle";
  const isTerminal =
    display === "completed" ||
    display === "completed_via_recovery" ||
    display === "failed" ||
    display === "cancelled_stale";

  if (isInteractiveSession(row) && row.status === "running") {
    items.push({ label: "End this turn", icon: "pause", onSelect: () => a.abort.mutate(row.id) });
  }
  if (isLive || isQueued) {
    items.push({
      label: "Stop session",
      icon: "stop",
      danger: true,
      separatorBefore: items.length > 0,
      onSelect: () => a.cancel.mutate(row.id),
    });
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
  const issues = row.issues ?? [];
  const title = sessionTitle(row) ?? "Untitled session";
  const disagreement = leaseDisagreementText(issues.filter((i) => i.boxReturned).map((i) => i.displayId));
  return (
    <div className="min-w-0">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="block w-full text-left focus-visible:outline-none"
        >
          <span title={title} className="fg-body-sm block break-words text-fg hover:text-accent-text sm:truncate">
            {title}
          </span>
        </button>
      ) : (
        <p title={title} className="fg-body-sm break-words text-fg sm:truncate">
          {title}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {issues.map((issue) =>
          slug ? (
            <IssueRefBadge
              key={issue.id}
              id={issue.id}
              slug={slug}
              displayId={issue.displayId}
              title={issue.title}
            />
          ) : (
            <span key={issue.id} className="fg-caption truncate" title={issue.title}>
              {issue.displayId}
            </span>
          ),
        )}
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
      {disagreement && <p className="fg-caption mt-1 break-words text-muted">{disagreement}</p>}
    </div>
  );
}

/** Runner/device cell: friendly name (or short id for an unknown owner's
 *  device) + a shared-threshold alive/stale dot for live sessions. */
function RunnerCell({
  row,
  deviceName,
  now,
}: {
  row: SessionRow;
  deviceName?: string;
  now: number;
}) {
  if (!row.deviceId) return <span className="fg-caption text-subtle">—</span>;
  const health = boxDotOf(row, now);
  return (
    <div className="flex items-center gap-1.5 overflow-hidden">
      {health && (
        <span data-testid="box-dot" data-health={health} className="inline-flex">
          <HealthDot health={health} withLabel={false} />
        </span>
      )}
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
}: {
  row: SessionRow;
  display: AgentSessionDisplayStatus;
  stage: string | undefined;
  now: number;
}) {
  const liveness = deriveLiveness(row, now);
  const word = sessionWord(row, now);
  const endText = quietEndText(liveness);
  const closeText = chatCloseText(row, now);
  // ISS-664 — a finished interactive chat awaiting the owner's reply gets its
  // own distinct chip (the `waiting` StatusKey — amber "a human must act"),
  // taking priority over the generic idle→paused mapping used everywhere else
  // (ChatScreen/SessionScreen keep that mapping unchanged; this is list-only).
  const awaitingReply = isAwaitingReply(row);
  const outcome = classifySessionOutcome(display, row.failureReason, row.startedAt != null);
  const chipStatus = sessionChipStatusOf(row, display);
  const reason = failureReasonLabel(row.failureReason) ?? row.failureReason ?? null;
  // Why it ended, or core's note on one it has not, in the sentences the session page and runs tab say.
  const subLine =
    display === "failed" || display === "cancelled_stale"
      ? sessionEndText(row.failureReason)
      : display === "stalled" && reason
        ? coreNoteText(reason)
        : null;
  // Red reason text only for a genuine failure; swept/cleanup reads subtle.
  const reasonColor = outcome.bucket === "failed" ? "var(--amberw-600)" : "var(--fg-subtle)";
  return (
    <div className="flex flex-col items-start gap-1">
      {!awaitingReply && outcome.tooltip ? (
        <Tooltip label={outcome.tooltip}>
          <SessionChip status={chipStatus} stage={stage} session={row} now={now} />
        </Tooltip>
      ) : (
        <SessionChip status={chipStatus} stage={stage} session={row} now={now} />
      )}
      {subLine && (
        <span className="fg-caption" style={{ color: reasonColor }}>
          {subLine}
        </span>
      )}
      {word?.quiet && <span className="fg-caption text-subtle">{word.label}</span>}
      {endText && (
        <span className="fg-caption text-subtle" title={ENDS_AS_FAILED_HOVER}>
          {endText}
        </span>
      )}
      {closeText && <span className="fg-caption text-subtle">{closeText}</span>}
    </div>
  );
}

function useRowDuration(row: SessionRow, display: AgentSessionDisplayStatus): string {
  return useSessionDuration(row, isLiveDisplay(display));
}

function SessionTableRow({
  row,
  slug,
  deviceName,
  now,
  actions,
  projectId,
  onInlineOpen,
  depth,
  hasChildren,
}: {
  row: SessionRow;
  slug?: string;
  deviceName?: string;
  now: number;
  actions: RowActions;
  /** How far under its owner this row sits, in the list as filtered. */
  depth: number;
  /** Whether anything in this list is owned by it. */
  hasChildren: boolean;
  /** Set at the project tier only — when present, rows navigate as before. */
  projectId?: string;
  /** Workspace tier only (ISS-664): opens the inline reply panel instead of
   *  navigating away from the cross-project list. */
  onInlineOpen: (id: string) => void;
}) {
  const router = useRouter();
  const display = deriveSessionDisplayStatus(row, now);
  const duration = useRowDuration(row, display);
  const stage = sessionStep(row.metadata) ?? undefined;
  // ISS-664 — tier-aware open: project tier keeps the existing route
  // navigation; workspace tier opens the inline reply panel instead (no
  // navigation, list stays visible).
  const open = projectId
    ? slug
      ? () => router.push(`/projects/${slug}/agents/${row.id}`)
      : undefined
    : () => onInlineOpen(row.id);
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
            <span className="text-11 text-muted" title="This session owns others in this list.">
              &#8226;
            </span>
          )}
        </div>
      </TD>
      <TD className="w-full min-w-[200px] max-w-0">
        <SessionIdentity row={row} slug={slug} onOpen={open} />
      </TD>
      <TD className="max-w-[160px]">
        <RunnerCell row={row} deviceName={deviceName} now={now} />
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

/** What species the row says it is: one word per kind, five of them. */
const KIND_TONE = {
  master: "accent",
  run_session: "cobalt",
  pipeline: "neutral",
  pm: "neutral",
  chat: "neutral",
} as const satisfies Record<AgentSessionKind, "neutral" | "accent" | "cobalt">;

/** A running chat spawns no job, so it is not a wedged runner (ISS-378 AC#4); the kind says which. */
function SessionKindTag({ row }: { row: SessionRow }) {
  const kind = sessionKind(row);
  const tag = <Badge tone={KIND_TONE[kind]}>{SESSION_KIND_LABEL[kind]}</Badge>;
  if (kind !== "chat") return tag;
  return <Tooltip label={CHAT_TAG_HOVER}>{tag}</Tooltip>;
}

function SessionMobileRow({
  row,
  slug,
  deviceName,
  now,
  actions,
  projectId,
  onInlineOpen,
  depth,
}: {
  row: SessionRow;
  slug?: string;
  deviceName?: string;
  now: number;
  actions: RowActions;
  depth: number;
  projectId?: string;
  onInlineOpen: (id: string) => void;
}) {
  const router = useRouter();
  const display = deriveSessionDisplayStatus(row, now);
  const duration = useRowDuration(row, display);
  const stage = sessionStep(row.metadata) ?? undefined;
  const open = projectId
    ? slug
      ? () => router.push(`/projects/${slug}/agents/${row.id}`)
      : undefined
    : () => onInlineOpen(row.id);
  return (
    // The same edge the table shows, at a width a phone can carry: the nesting
    // has to survive the narrow layout or the tree is a desktop-only claim.
    <li className="py-3">
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
            <RunnerCell row={row} deviceName={deviceName} now={now} />
          </div>
        )}
    </li>
  );
}
