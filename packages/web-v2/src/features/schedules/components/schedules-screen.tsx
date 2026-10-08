"use client";

// Project-tier Schedules (rendered inside the Automation tab). Full-width table
// on desktop, a flush hairline-divided list on mobile. Real `/api/schedules` data with an enable
// Toggle, manual run, and an expandable run-history panel (ISS-299 + history). The row's state
// cell speaks for the present (paused, or the next run); the last run is a dated fact (ISS-1163).
import { useParams } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  PageContainer,
  PageTitle,
  Skeleton,
  Spinner,
  StatusChip,
  Table,
  TBody,
  TD,
  TH,
  THead,
  Toggle,
  Tooltip,
  TR,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useRunSchedule, useScheduleRuns, useSchedules, useSetScheduleEnabled } from "../hooks";
import { describeCadence, lastRunView, listSum, STALE_RULE } from "../present-state";
import {
  lastStatusToChip,
  sessionStatusToChip,
  type ScheduleKind,
  type ScheduleLastStatus,
  type ScheduleRow,
  type ScheduleRun,
  type StewardRunReportAction,
} from "../types";

/** Distinguishes a script-kind row from a prompt-kind one — @/design tokens only. */
function ScheduleKindBadge({ kind }: { kind: ScheduleKind }) {
  return (
    <Badge tone={kind === "script" ? "cobalt" : "neutral"}>
      {kind === "script" ? "Script" : "Prompt"}
    </Badge>
  );
}

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
 * The schedule's present state, in words: paused, or when it runs next. The only element of a
 * row that speaks for the present, and never coloured by the last run.
 */
function ScheduleState({ row }: { row: ScheduleRow }) {
  if (!row.enabled) {
    return (
      <>
        <p className="fg-body-sm text-fg font-medium">Paused</p>
        <p className="fg-caption text-subtle">Won&apos;t run until it is switched on</p>
      </>
    );
  }
  return (
    <>
      <p className="fg-body-sm text-fg font-medium">Next run</p>
      <p className="fg-caption font-mono text-muted">{fmtTime(row.nextRunAt)}</p>
    </>
  );
}

/** Cadence in words with the cron expression kept beneath; an unreadable one shows the expression alone. */
function ScheduleCadence({ cron }: { cron: string }) {
  const { words, expression } = describeCadence(cron);
  return (
    <>
      {words && <p className="fg-body-sm text-fg">{words}</p>}
      <p className="fg-caption font-mono text-subtle" title="Cron expression">
        {expression}
      </p>
    </>
  );
}

/**
 * The last run as a dated fact: neutral caption text with its age, marked stale once it no
 * longer speaks for the schedule. When the run has a session the text links to it.
 */
function LastRun({
  row,
  now,
  slug,
}: {
  row: ScheduleRow;
  now: Date;
  slug: string | undefined;
}) {
  const view = lastRunView(row, now);
  if (view.kind === "never") {
    return <span className="fg-caption text-subtle">Never run</span>;
  }
  const inner = (
    <span className="fg-caption text-subtle" title={fmtTime(row.lastRunAt)}>
      {view.text}
      {view.stale && <span> · stale</span>}
    </span>
  );
  if (slug && row.lastSessionId) {
    return (
      <Link
        href={`/projects/${slug}/agents/${row.lastSessionId}`}
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

/** One past run inside the expanded history panel. Prompt-kind links to its
 *  session; script-kind has no session — it shows captured output/error inline. */
function ScheduleRunItem({
  run,
  slug,
  kind,
}: {
  run: ScheduleRun;
  slug: string | undefined;
  kind: ScheduleKind;
}) {
  const chip =
    kind === "script"
      ? lastStatusToChip(run.status as ScheduleLastStatus)
      : sessionStatusToChip(run.status);

  const header = (
    <div className="flex flex-wrap items-center gap-2 py-1.5">
      <Badge tone={run.trigger === "manual" ? "accent" : "neutral"}>{run.trigger}</Badge>
      {chip && <StatusChip status={chip} size="sm" domain="session" />}
      <span className="fg-caption text-subtle">{fmtTime(run.startedAt)}</span>
      <span className="fg-caption font-mono text-subtle">{fmtDuration(run.durationSeconds)}</span>
      {kind === "prompt" && run.failureReason && (
        <Tooltip label={run.failureReason}>
          <span className="fg-caption text-danger underline decoration-dotted">why?</span>
        </Tooltip>
      )}
      {kind === "prompt" && slug && (
        <span className="fg-caption text-accent">View session →</span>
      )}
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

  const scriptOutputSection = kind === "script" && (
    <div className="pb-1.5 pl-1 space-y-1">
      {run.output && (
        <pre className="fg-caption max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-subtle p-2 text-muted">
          {run.output}
        </pre>
      )}
      {run.error && <p className="fg-caption break-words text-danger">{run.error}</p>}
    </div>
  );

  if (kind === "prompt" && slug) {
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
      {scriptOutputSection}
    </div>
  );
}

/** Expanded panel: the schedule's prompt + target meta + recent runs. */
function ScheduleHistory({ row, slug }: { row: ScheduleRow; slug: string | undefined }) {
  const runsQ = useScheduleRuns(row.projectId, row.id, true);
  const runs = runsQ.data?.runs ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ScheduleKindBadge kind={row.kind} />
        {row.targetProjectSlug && (
          <span className="fg-caption font-mono text-subtle">→ {row.targetProjectSlug}</span>
        )}
      </div>
      {row.kind === "prompt" ? (
        <p className="fg-caption whitespace-pre-wrap break-words text-muted line-clamp-3">
          {row.prompt}
        </p>
      ) : (
        row.script && (
          <pre className="fg-caption max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-subtle p-2 text-muted">
            {row.script}
          </pre>
        )
      )}

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
              <ScheduleRunItem key={r.sessionId} run={r} slug={slug} kind={row.kind} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface RowActions {
  /** One clock for the whole render, so every age on screen is measured against the same instant. */
  now: Date;
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
    now: new Date(),
    setEnabled: (id, enabled) => setEnabled.mutate({ id, enabled }),
    run: (id) => runMut.mutateAsync(id),
    pending: setEnabled.isPending || runMut.isPending,
    canManage,
    slug,
  };

  return (
    <PageContainer className="min-h-dvh">
      <header className="mb-6">
        <PageTitle className="fg-h2">Schedules</PageTitle>
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
          <div className="mb-3">
            <p className="fg-body-sm text-fg font-medium">{listSum(rows)}</p>
            <p className="fg-caption text-subtle">{STALE_RULE}</p>
          </div>

          {/* Desktop / tablet: full-width table. */}
          <div className="hidden md:block">
            <Table>
              <THead>
                <TR>
                  <TH className="w-8" aria-label="Expand" />
                  <TH className="w-12">On</TH>
                  <TH>Name · target</TH>
                  <TH>Cadence</TH>
                  <TH>State</TH>
                  <TH>Last run</TH>
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

          {/* Mobile: a flush list divided by hairlines — no card per row, no horizontal page scroll. */}
          <div className="border-t border-line-subtle md:hidden">
            {rows.map((row) => (
              <ScheduleMobileItem key={row.id} row={row} actions={actions} />
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
          <div className="flex items-center gap-1.5">
            <p className="fg-body-sm truncate text-fg">{row.name}</p>
            <ScheduleKindBadge kind={row.kind} />
          </div>
          {row.targetProjectSlug && (
            <span className="fg-caption font-mono">→ {row.targetProjectSlug}</span>
          )}
        </TD>
        <TD>
          <ScheduleCadence cron={row.cron} />
        </TD>
        <TD>
          <ScheduleState row={row} />
        </TD>
        <TD>
          <LastRun row={row} now={actions.now} slug={actions.slug} />
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

function ScheduleMobileItem({ row, actions }: { row: ScheduleRow; actions: RowActions }) {
  const [open, setOpen] = useState(false);

  async function handleRun() {
    try {
      await actions.run(row.id);
      setOpen(true);
    } catch {
      // error is surfaced by the mutation's onError toast
    }
  }

  return (
    <div className="border-b border-line-subtle py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="fg-body-sm truncate text-fg">{row.name}</p>
            <ScheduleKindBadge kind={row.kind} />
          </div>
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
      <div className="mt-3">
        <ScheduleState row={row} />
      </div>
      <div className="mt-2">
        <ScheduleCadence cron={row.cron} />
      </div>
      <div className="mt-2">
        <LastRun row={row} now={actions.now} slug={actions.slug} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex min-h-11 items-center gap-1 fg-caption text-accent focus-visible:outline-none"
        >
          {open ? "Hide history" : "Show history"}
        </button>
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
      {open && (
        <div className="mt-3 border-t border-line-subtle pt-3">
          <ScheduleHistory row={row} slug={actions.slug} />
        </div>
      )}
    </div>
  );
}
