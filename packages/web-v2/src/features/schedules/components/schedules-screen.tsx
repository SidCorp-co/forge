"use client";

// Project-tier Schedules (`/v2/projects/[slug]/schedules`). Full-width table on
// desktop, stacked cards on mobile. Real `/api/schedules` data with an enable
// Toggle + manual run. ISS-299.
import {
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  MonoTag,
  Skeleton,
  StatusChip,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Toggle,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useRunSchedule, useSchedules, useSetScheduleEnabled } from "../hooks";
import { lastStatusToChip, type ScheduleRow } from "../types";

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

/**
 * Condensed last-result: status chip + the time it ran, inline. Renders nothing
 * when a schedule has never run (no chip, no em dash).
 */
function LastResult({ status, at }: { status: ScheduleRow["lastStatus"]; at: string | null }) {
  const chip = lastStatusToChip(status);
  if (!chip) {
    return <span className="fg-caption text-subtle">Never run</span>;
  }
  return (
    <span className="inline-flex items-center gap-2">
      <StatusChip status={chip} size="sm" />
      {at && <span className="fg-caption text-subtle">{fmtTime(at)}</span>}
    </span>
  );
}

interface RowActions {
  setEnabled: (id: string, enabled: boolean) => void;
  run: (id: string) => void;
  pending: boolean;
  canManage: boolean;
}

export function SchedulesScreen({ scope }: SchedulesScreenProps) {
  const { projectId, canManage } = scope;
  const schedulesQ = useSchedules(projectId);
  const setEnabled = useSetScheduleEnabled(projectId);
  const run = useRunSchedule(projectId);

  const rows = schedulesQ.data ?? [];
  const actions: RowActions = {
    setEnabled: (id, enabled) => setEnabled.mutate({ id, enabled }),
    run: (id) => run.mutate(id),
    pending: setEnabled.isPending || run.isPending,
    canManage,
  };

  return (
    <div className="mx-auto w-full min-h-dvh max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <header className="mb-6">
        <h1 className="fg-h2">Schedules</h1>
        <p className="fg-body-sm mt-1">Recurring agent runs for this project.</p>
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
    </div>
  );
}

function ScheduleTableRow({ row, actions }: { row: ScheduleRow; actions: RowActions }) {
  return (
    <TR>
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
        <LastResult status={row.lastStatus} at={row.lastRunAt} />
      </TD>
      <TD className="text-right">
        <Button
          variant="secondary"
          size="sm"
          icon="play"
          disabled={!actions.canManage || actions.pending}
          onClick={() => actions.run(row.id)}
          className="min-h-11"
        >
          Run
        </Button>
      </TD>
    </TR>
  );
}

function ScheduleMobileCard({ row, actions }: { row: ScheduleRow; actions: RowActions }) {
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
          <LastResult status={row.lastStatus} at={row.lastRunAt} />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          {row.enabled ? (
            <span className="fg-caption font-mono text-subtle">
              Next: {fmtTime(row.nextRunAt)}
            </span>
          ) : (
            <span className="fg-caption text-subtle">Off</span>
          )}
          <Button
            variant="secondary"
            size="sm"
            icon="play"
            disabled={!actions.canManage || actions.pending}
            onClick={() => actions.run(row.id)}
            className="min-h-11"
          >
            Run
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
