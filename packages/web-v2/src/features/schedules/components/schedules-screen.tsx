"use client";

// cm:why a schedule's next fire, last result and fire history are read from the automation read
// model (ISS-114), never derived here; `/api/schedules` supplies only what the row edits
import { useParams } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import {
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  IconButton,
  MonoTag,
  PageContainer,
  PageTitle,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  Toggle,
  TR,
  EnumBadge,
  StatusBadge,
} from "@/design";
import { FireHistory } from "@/features/automation/components/fire-history";
import {
  useAutomationStanding,
  usePmConfig,
  usePmDecisions,
  useRunPm,
  useUpdatePmConfig,
} from "@/features/automation/hooks";
import type { ScheduleStanding } from "@/features/automation/types";
import { PmSettings, pmCadenceLabel } from "@/features/automation/components/pm-settings";
import { formatApiError } from "@/lib/api/error";
import { useRunSchedule, useSchedules, useSetScheduleEnabled } from "../hooks";
import type { ScheduleKind, ScheduleRow } from "../types";

const SKELETON_ROWS = ["s1", "s2", "s3", "s4", "s5"];

function ScheduleKindBadge({ kind }: { kind: ScheduleKind | "pm" | "improve" }) {
  return <EnumBadge family="scheduleKind" value={kind} />;
}

interface SchedulesScreenProps {
  scope: { projectId: string; canManage: boolean };
  /** The page's title when it hosts this screen as a tab (Automation); the screen's own otherwise. */
  header?: React.ReactNode;
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

/** The schedule's newest fire as the read model serves it, linked to its session when it ran one. */
function LastResult({ standing, slug }: { standing: ScheduleStanding | undefined; slug: string | undefined }) {
  const last = standing?.lastFire;
  if (!last) {
    return <span className="fg-caption text-subtle">Never run</span>;
  }
  const inner = (
    <span className="inline-flex items-center gap-2">
      <StatusBadge family="scheduleRun" value={last.status} />
      <span className="fg-caption text-subtle">{fmtTime(last.startedAt)}</span>
    </span>
  );
  if (slug && last.sessionId) {
    return (
      <Link
        href={`/projects/${slug}/agents/${last.sessionId}`}
        className="rounded-md hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        {inner}
      </Link>
    );
  }
  return inner;
}

/** When the ticker claims it next, as the read model serves it: Off while it is paused. */
function NextFire({ standing, mobile }: { standing: ScheduleStanding | undefined; mobile?: boolean }) {
  if (standing?.state === "off") return <span className="fg-caption font-sans text-subtle">Off</span>;
  const at = fmtTime(standing?.nextFireAt ?? null);
  return mobile ? <span className="fg-caption font-mono text-subtle">Next: {at}</span> : <span>{at}</span>;
}

/** Expanded panel: the schedule's prompt + target meta + recent runs. */
function ScheduleHistory({ row, slug }: { row: ScheduleRow; slug: string | undefined }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ScheduleKindBadge kind={row.templateKey ? "improve" : row.kind} />
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

      <FireHistory projectId={row.projectId} scheduleId={row.id} slug={slug} />
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
  standingOf: (id: string) => ScheduleStanding | undefined;
}

export function SchedulesScreen({ scope, header }: SchedulesScreenProps) {
  const { projectId, canManage } = scope;
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;
  const schedulesQ = useSchedules(projectId);
  const setEnabled = useSetScheduleEnabled(projectId);
  const runMut = useRunSchedule(projectId);
  const pmQ = usePmConfig(projectId);
  const standingQ = useAutomationStanding(projectId);
  const standings = new Map((standingQ.data?.schedules ?? []).map((s) => [s.id, s]));

  const rows = schedulesQ.data ?? [];
  const actions: RowActions = {
    setEnabled: (id, enabled) => setEnabled.mutate({ id, enabled }),
    run: (id) => runMut.mutateAsync(id),
    pending: setEnabled.isPending || runMut.isPending,
    canManage,
    slug,
    standingOf: (id) => standings.get(id),
  };

  return (
    <PageContainer className="min-h-dvh">
      {header ?? (
        <PageTitle hint="Recurring runs for this project, the PM sweep among them. Expand a row to see its history or settings.">
          Schedules
        </PageTitle>
      )}

      {schedulesQ.isLoading && (
        <div className="space-y-2.5">
          {SKELETON_ROWS.map((k) => (
            <Skeleton key={k} className="h-16 w-full rounded-lg" />
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

      {!schedulesQ.isLoading && !schedulesQ.isError && (
        <>
          {rows.length === 0 && pmQ.isError && (
            <EmptyState
              title="No schedules yet"
              message="Recurring agent runs for this project will appear here."
            />
          )}
          {pmQ.isError && (
            <ErrorState
              title="Couldn't load the PM sweep"
              message={formatApiError(pmQ.error)}
              onRetry={() => pmQ.refetch()}
            />
          )}
        </>
      )}

      {!schedulesQ.isLoading && !schedulesQ.isError && (rows.length > 0 || pmQ.data) && (
        <>
          {/* Desktop / tablet: full-width table. */}
          <div className="hidden md:block">
            <Table>
              <THead>
                <TR>
                  <TH className="w-8" aria-label="Expand" />
                  <TH className="w-12">On</TH>
                  <TH>Name · target</TH>
                  <TH>Kind</TH>
                  <TH>Cadence</TH>
                  <TH>Next run</TH>
                  <TH>Last result</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {pmQ.data && <PmScheduleRow projectId={projectId} canManage={canManage} />}
                {rows.map((row) => (
                  <ScheduleTableRow key={row.id} row={row} actions={actions} />
                ))}
              </TBody>
            </Table>
          </div>

          {/* Mobile: stacked cards — no horizontal page scroll. */}
          <div className="space-y-2.5 md:hidden">
            {pmQ.data && <PmScheduleCard projectId={projectId} canManage={canManage} />}
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
          <ScheduleKindBadge kind={row.templateKey ? "improve" : row.kind} />
        </TD>
        <TD>
          <MonoTag>{row.cron}</MonoTag>
        </TD>
        <TD className="font-mono text-muted">
          <NextFire standing={actions.standingOf(row.id)} />
        </TD>
        <TD>
          <LastResult standing={actions.standingOf(row.id)} slug={actions.slug} />
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
          <TD colSpan={8} className="bg-surface-subtle">
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
    }
  }

  return (
    <Card>
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="fg-body-sm truncate text-fg">{row.name}</p>
              <ScheduleKindBadge kind={row.templateKey ? "improve" : row.kind} />
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
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <MonoTag>{row.cron}</MonoTag>
          <LastResult standing={actions.standingOf(row.id)} slug={actions.slug} />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <NextFire standing={actions.standingOf(row.id)} mobile />
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

function usePmRow(projectId: string) {
  const configQ = usePmConfig(projectId);
  const lastQ = usePmDecisions(projectId, 1, 1);
  const update = useUpdatePmConfig(projectId);
  const run = useRunPm(projectId);
  return { config: configQ.data, last: lastQ.data?.items[0] ?? null, update, run };
}

function PmLastRun({ last }: { last: { cause: string; createdAt: string } | null }) {
  if (!last) return <span className="fg-caption text-subtle">No decision yet</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <EnumBadge family="pmCause" value={last.cause} />
      <span className="fg-caption text-subtle">{fmtTime(last.createdAt)}</span>
    </span>
  );
}

function PmScheduleRow({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const [open, setOpen] = useState(false);
  const { config, last, update, run } = usePmRow(projectId);
  if (!config) return null;
  return (
    <>
      <TR data-testid="pm-schedule-row">
        <TD className="pr-0">
          <IconButton
            icon="chevronRight"
            size="sm"
            aria-label={open ? "Close PM settings" : "Open PM settings"}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 150ms" }}
          />
        </TD>
        <TD>
          <Toggle
            checked={config.enabled}
            disabled={!canManage || update.isPending}
            aria-label={`${config.enabled ? "Disable" : "Enable"} PM sweep`}
            onChange={(next) => update.mutate({ enabled: next })}
          />
        </TD>
        <TD>
          <p className="fg-body-sm text-fg">PM sweep</p>
        </TD>
        <TD>
          <ScheduleKindBadge kind="pm" />
        </TD>
        <TD>
          <MonoTag>{pmCadenceLabel(config)}</MonoTag>
        </TD>
        <TD className="font-mono text-muted">
          {config.enabled ? "—" : <span className="fg-caption font-sans text-subtle">Off</span>}
        </TD>
        <TD>
          <PmLastRun last={last} />
        </TD>
        <TD className="text-right">
          <Button
            variant="secondary"
            size="sm"
            icon="play"
            disabled={!canManage || run.isPending}
            onClick={() => run.mutate()}
            className="min-h-11"
          >
            Run
          </Button>
        </TD>
      </TR>
      {open && (
        <TR>
          <TD colSpan={8} className="bg-surface-subtle">
            <PmSettings projectId={projectId} canManage={canManage} />
          </TD>
        </TR>
      )}
    </>
  );
}

function PmScheduleCard({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const [open, setOpen] = useState(false);
  const { config, last, update, run } = usePmRow(projectId);
  if (!config) return null;
  return (
    <Card>
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="fg-body-sm text-fg">PM sweep</p>
            <ScheduleKindBadge kind="pm" />
          </div>
          <Toggle
            checked={config.enabled}
            disabled={!canManage || update.isPending}
            aria-label={`${config.enabled ? "Disable" : "Enable"} PM sweep`}
            onChange={(next) => update.mutate({ enabled: next })}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <MonoTag>{pmCadenceLabel(config)}</MonoTag>
          <PmLastRun last={last} />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1 fg-caption text-accent focus-visible:outline-none"
          >
            {open ? "Hide settings" : "Settings"}
          </button>
          <Button
            variant="secondary"
            size="sm"
            icon="play"
            disabled={!canManage || run.isPending}
            onClick={() => run.mutate()}
            className="min-h-11"
          >
            Run
          </Button>
        </div>
        {open && (
          <div className="mt-3 border-t border-line-subtle pt-3">
            <PmSettings projectId={projectId} canManage={canManage} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
