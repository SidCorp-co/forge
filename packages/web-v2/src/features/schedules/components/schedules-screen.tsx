"use client";

// Project-tier Schedules (rendered inside the Automation tab). Full-width table
// on desktop, stacked cards on mobile. Real `/api/schedules` data with an enable
// Toggle, manual run, and an expandable run-history panel (ISS-299 + history).
import { useParams } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  IconButton,
  MonoTag,
  PageContainer,
  Skeleton,
  Spinner,
  StatusChip,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Toggle,
  Tooltip,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useRunSchedule, useScheduleRuns, useSchedules, useSetScheduleEnabled } from "../hooks";
import {
  lastStatusToChip,
  sessionStatusToChip,
  type ScheduleRow,
  type ScheduleRun,
  type StewardRunReportAction,
} from "../types";

interface SchedulesScreenProps {
  scope: { projectId: string; canManage: boolean };
}

/** Absolute local timestamp, or em dash. */
function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Human run duration: "45s" / "2m 03s" / em dash when unknown. */
function fmtDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/**
 * Condensed last-result: status chip + the time it ran, inline. When the last
 * run has a session, the whole thing links to that session's detail. Renders a
 * muted "Never run" when a schedule has no run yet.
 */
function LastResult({
  status,
  at,
  sessionId,
  slug,
}: {
  status: ScheduleRow["lastStatus"];
  at: string | null;
  sessionId: string | null;
  slug: string | undefined;
}) {
  const chip = lastStatusToChip(status);
  if (!chip) {
    return <span className="fg-caption text-subtle">Never run</span>;
  }
  const inner = (
    <span className="inline-flex items-center gap-2">
      <StatusChip status={chip} size="sm" domain="session" />
      {at && <span className="fg-caption text-subtle">{fmtTime(at)}</span>}
    </span>
  );
  if (slug && sessionId) {
    return (
      <Link
        href={`/projects/${slug}/agents/${sessionId}`}
        className="rounded-md hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        {inner}
      </Link>
    );
  }
  return inner;
}

const ACTION_TONE: Record<StewardRunReportAction["kind"], "green" | "cobalt" | "amber" | "neutral"> =
  {
    applied: "green",
    proposed: "cobalt",
    feedback: "amber",
    skipped: "neutral",
  };

/** One past run inside the expanded history panel. Links to its session. */
function ScheduleRunItem({ run, slug }: { run: ScheduleRun; slug: string | undefined }) {
  const header = (
    <div className="flex flex-wrap items-center gap-2 py-1.5">
      <Badge tone={run.trigger === "manual" ? "accent" : "neutral"}>{run.trigger}</Badge>
      <StatusChip status={sessionStatusToChip(run.status)} size="sm" domain="session" />
      <span className="fg-caption text-subtle">{fmtTime(run.startedAt)}</span>
      <span className="fg-caption font-mono text-subtle">{fmtDuration(run.durationSeconds)}</span>
      {run.failureReason && (
        <Tooltip label={run.failureReason}>
          <span className="fg-caption text-danger underline decoration-dotted">why?</span>
        </Tooltip>
      )}
      {slug && <span className="fg-caption text-accent">View session →</span>}
    </div>
  );

  const stewardSection = run.stewardReport && (
    <div className="pb-1.5 pl-1 space-y-1">
      {run.stewardReport.weakestDomain && (
        <p className="fg-caption text-subtle">
          Weakest domain: <span className="font-mono">{run.stewardReport.weakestDomain}</span>
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {run.stewardReport.actions.map((a, i) => (
          <Tooltip key={i} label={a.summary}>
            <span className="inline-flex items-center gap-1">
              <Badge tone={ACTION_TONE[a.kind]}>{a.kind}</Badge>
              <span className="fg-caption text-muted max-w-[160px] truncate">{a.skill}</span>
            </span>
          </Tooltip>
        ))}
      </div>
    </div>
  );

  if (slug) {
    return (
      <div className="rounded-md px-1 hover:bg-hover">
        <Link
          href={`/projects/${slug}/agents/${run.sessionId}`}
          className="block focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          {header}
        </Link>
        {stewardSection}
      </div>
    );
  }
  return (
    <div>
      {header}
      {stewardSection}
    </div>
  );
}

/** Expanded panel: the schedule's prompt + runner/target meta + recent runs. */
function ScheduleHistory({ row, slug }: { row: ScheduleRow; slug: string | undefined }) {
  const runsQ = useScheduleRuns(row.projectId, row.id, true);
  const runs = runsQ.data?.runs ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {row.runner && <Badge tone="neutral">{row.runner}</Badge>}
        {row.targetProjectSlug && (
          <span className="fg-caption font-mono text-subtle">→ {row.targetProjectSlug}</span>
        )}
      </div>
      <p className="fg-caption whitespace-pre-wrap break-words text-muted line-clamp-3">
        {row.prompt}
      </p>

      <div>
        <p className="fg-label mb-1 text-subtle">Recent runs</p>
        {runsQ.isLoading && (
          <span className="inline-flex items-center gap-2 fg-caption text-subtle">
            <Spinner size={14} /> Loading runs…
          </span>
        )}
        {runsQ.isError && (
          <span className="fg-caption text-danger">
            Couldn&apos;t load run history — {formatApiError(runsQ.error)}
          </span>
        )}
        {!runsQ.isLoading && !runsQ.isError && runs.length === 0 && (
          <span className="fg-caption text-subtle">No runs yet.</span>
        )}
        {runs.length > 0 && (
          <div className="divide-y divide-line-subtle">
            {runs.map((r) => (
              <ScheduleRunItem key={r.sessionId} run={r} slug={slug} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface RowActions {
  setEnabled: (id: string, enabled: boolean) => void;
  /** Returns a promise so the row can reveal history once the run is queued. */
  run: (id: string) => Promise<unknown>;
  pending: boolean;
  canManage: boolean;
  slug: string | undefined;
}

export function SchedulesScreen({ scope }: SchedulesScreenProps) {
  const { projectId, canManage } = scope;
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;
  const schedulesQ = useSchedules(projectId);
  const setEnabled = useSetScheduleEnabled(projectId);
  const runMut = useRunSchedule(projectId);

  const rows = schedulesQ.data ?? [];
  const actions: RowActions = {
    setEnabled: (id, enabled) => setEnabled.mutate({ id, enabled }),
    run: (id) => runMut.mutateAsync(id),
    pending: setEnabled.isPending || runMut.isPending,
    canManage,
    slug,
  };

  return (
    <PageContainer className="min-h-dvh">
      <header className="mb-6">
        <h1 className="fg-h2">Schedules</h1>
        <p className="fg-body-sm mt-1">
          Recurring agent runs for this project. Expand a row to see its run history.
        </p>
      </header>

      {schedulesQ.isLoading && (
        <div className="space-y-2.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      )}

      {schedulesQ.isError && (
        <ErrorState
          title="Couldn't load schedules"
          message={formatApiError(schedulesQ.error)}
          onRetry={() => schedulesQ.refetch()}
        />
      )}

      {!schedulesQ.isLoading && !schedulesQ.isError && rows.length === 0 && (
        <EmptyState
          title="No schedules yet"
          message="Recurring agent runs for this project will appear here."
        />
      )}

      {!schedulesQ.isLoading && !schedulesQ.isError && rows.length > 0 && (
        <>
          {/* Desktop / tablet: full-width table. */}
          <div className="hidden md:block">
            <Table>
              <THead>
                <TR>
                  <TH className="w-8" aria-label="Expand" />
                  <TH className="w-12">On</TH>
                  <TH>Name · target</TH>
                  <TH>Cadence</TH>
                  <TH>Next run</TH>
                  <TH>Last result</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <ScheduleTableRow key={row.id} row={row} actions={actions} />
                ))}
              </TBody>
            </Table>
          </div>

          {/* Mobile: stacked cards — no horizontal page scroll. */}
          <div className="space-y-2.5 md:hidden">
            {rows.map((row) => (
              <ScheduleMobileCard key={row.id} row={row} actions={actions} />
            ))}
          </div>
        </>
      )}
    </PageContainer>
  );
}

function ScheduleTableRow({ row, actions }: { row: ScheduleRow; actions: RowActions }) {
  const [open, setOpen] = useState(false);

  async function handleRun() {
    try {
      await actions.run(row.id);
      setOpen(true); // reveal history so the new run shows up
    } catch {
      // error is surfaced by the mutation's onError toast
    }
  }

  return (
    <>
      <TR>
        <TD className="pr-0">
          <IconButton
            icon="chevronRight"
            size="sm"
            aria-label={open ? "Collapse history" : "Expand history"}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 150ms" }}
          />
        </TD>
        <TD>
          <Toggle
            checked={row.enabled}
            disabled={!actions.canManage || actions.pending}
            aria-label={`${row.enabled ? "Disable" : "Enable"} ${row.name}`}
            onChange={(next) => actions.setEnabled(row.id, next)}
          />
        </TD>
        <TD className="max-w-[280px]">
          <p className="fg-body-sm truncate text-fg">{row.name}</p>
          {row.targetProjectSlug && (
            <span className="fg-caption font-mono">→ {row.targetProjectSlug}</span>
          )}
        </TD>
        <TD>
          <MonoTag>{row.cron}</MonoTag>
        </TD>
        <TD className="font-mono text-muted">
          {row.enabled ? (
            fmtTime(row.nextRunAt)
          ) : (
            <span className="fg-caption font-sans text-subtle">Off</span>
          )}
        </TD>
        <TD>
          <LastResult
            status={row.lastStatus}
            at={row.lastRunAt}
            sessionId={row.lastSessionId}
            slug={actions.slug}
          />
        </TD>
        <TD className="text-right">
          <Button
            variant="secondary"
            size="sm"
            icon="play"
            disabled={!actions.canManage || actions.pending}
            onClick={handleRun}
            className="min-h-11"
          >
            Run
          </Button>
        </TD>
      </TR>
      {open && (
        <TR>
          <TD colSpan={7} className="bg-surface-subtle">
            <ScheduleHistory row={row} slug={actions.slug} />
          </TD>
        </TR>
      )}
    </>
  );
}

function ScheduleMobileCard({ row, actions }: { row: ScheduleRow; actions: RowActions }) {
  const [open, setOpen] = useState(false);

  async function handleRun() {
    try {
      await actions.run(row.id);
      setOpen(true);
    } catch {
      // error surfaced by the mutation's onError toast
    }
  }

  return (
    <Card>
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="fg-body-sm truncate text-fg">{row.name}</p>
            {row.targetProjectSlug && (
              <span className="fg-caption font-mono">→ {row.targetProjectSlug}</span>
            )}
          </div>
          <Toggle
            checked={row.enabled}
            disabled={!actions.canManage || actions.pending}
            aria-label={`${row.enabled ? "Disable" : "Enable"} ${row.name}`}
            onChange={(next) => actions.setEnabled(row.id, next)}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <MonoTag>{row.cron}</MonoTag>
          <LastResult
            status={row.lastStatus}
            at={row.lastRunAt}
            sessionId={row.lastSessionId}
            slug={actions.slug}
          />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          {row.enabled ? (
            <span className="fg-caption font-mono text-subtle">Next: {fmtTime(row.nextRunAt)}</span>
          ) : (
            <span className="fg-caption text-subtle">Off</span>
          )}
          <Button
            variant="secondary"
            size="sm"
            icon="play"
            disabled={!actions.canManage || actions.pending}
            onClick={handleRun}
            className="min-h-11"
          >
            Run
          </Button>
        </div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="mt-3 inline-flex items-center gap-1 fg-caption text-accent focus-visible:outline-none"
        >
          {open ? "Hide history" : "Show history"}
        </button>
        {open && (
          <div className="mt-3 border-t border-line-subtle pt-3">
            <ScheduleHistory row={row} slug={actions.slug} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
