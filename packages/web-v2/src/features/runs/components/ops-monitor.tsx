"use client";

// Ops monitor (`/ops`, ISS-295) — ONE tabbed surface (Monitor / Progress /
// Health / Runs) collapsing the old /pipeline,/progress,/health,/runs into a
// single Tabs view on real cross-project data. Live via WS: cross-project
// events only arrive on subscribed rooms, so we fan out a `useRoom` per project
// (bounded list) — `pipeline_run.status_changed` then refreshes
// `['projects','health']` + `['pipeline-runs','list']`.
import { jobKindLabel } from "@/features/overview/job-kinds";
import { OPEN_WORK_LABEL } from "@forge/contracts/work-state";
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  HealthDot,
  HelpButton,
  PageContainer,
  PageTitle,
  ProgressBar,
  ProjectLoader,
  Stat,
  Table,
  Tabs,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/design";
import { deriveHealth } from "@/features/projects/derive";
import { useOrgScopedProjects, useProjectHealth } from "@/features/projects/hooks";
import type { ProjectHealthRow } from "@/features/projects/types";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { formatDurationSec, formatUsd } from "@/lib/utils/format";
import { useStepDurations, useThroughput } from "../hooks";
import type { StepDurationRow, ThroughputRow } from "../types";
import { RunDetail } from "./run-detail";

const TABS = [
  { value: "monitor", label: "Monitor" },
  { value: "progress", label: "Progress" },
  { value: "health", label: "Health" },
  { value: "runs", label: "Runs" },
];

/** Subscribes to one WS room for its lifetime (renders nothing). Lets us fan
 *  out room subscriptions over a list without breaking the rules-of-hooks. */
function RoomSub({ room }: { room: string }) {
  useRoom(room);
  return null;
}

export function OpsMonitor() {
  const [tab, setTab] = useState("monitor");
  const [runId, setRunId] = useState<string | null>(null);

  // Open a run directly from a shared deep-link (`/ops?run=<id>`).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const shared = new URLSearchParams(window.location.search).get("run");
    if (shared) {
      setRunId(shared);
      setTab("runs");
    }
  }, []);

  // ISS-477 — scope the whole monitor to the active org's projects. The health
  // rollup (AC #4) filters by project id; the step-duration/throughput rows also
  // carry `projectId`, so we client-filter them too for a coherent active-org
  // view (Monitor/Progress/Runs). Note: those aggregates are fetched with a
  // server-side window/top-N, so the org-scoped slice is best-effort — a true
  // org-aggregate endpoint is a documented follow-up.
  const { projects, projectIds, isLoading: projectsLoading, error: projectsError } =
    useOrgScopedProjects();
  const healthQ = useProjectHealth();
  const durationsQ = useStepDurations({ days: 7 });
  const throughputQ = useThroughput({ days: 30 });

  const health = useMemo(
    () => (healthQ.data ?? []).filter((h) => projectIds.has(h.id)),
    [healthQ.data, projectIds],
  );
  const durations = useMemo(
    () => (durationsQ.data ?? []).filter((r) => projectIds.has(r.projectId)),
    [durationsQ.data, projectIds],
  );
  const throughput = useMemo(
    () => (throughputQ.data ?? []).filter((r) => projectIds.has(r.projectId)),
    [throughputQ.data, projectIds],
  );
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.name);
    for (const h of health) if (!m.has(h.id)) m.set(h.id, h.projectName);
    return m;
  }, [projects, health]);

  if (projectsLoading || healthQ.isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading ops…" />
      </div>
    );
  }
  if (projectsError || healthQ.isError) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState
          message={formatApiError(projectsError ?? healthQ.error)}
          onRetry={() => healthQ.refetch()}
        />
      </div>
    );
  }

  return (
    <PageContainer className="flex min-h-dvh flex-col">
      {/* Cross-project live fan-out */}
      {projects.map((p) => (
        <RoomSub key={p.id} room={projectRoom(p.id)} />
      ))}

      <header className="mb-5 flex items-start justify-between gap-3">
        <div>
          <PageTitle className="fg-h2">Ops</PageTitle>
          <p className="fg-body-sm mt-1 text-muted">
            Cross-project run telemetry, step durations, and spend — live across {projects.length}{" "}
            project{projects.length === 1 ? "" : "s"}.
          </p>
        </div>
        <HelpButton
          summary="A live cross-project view of pipeline runs: real-time monitor, throughput and stage-duration progress, project health, and a recent-runs list."
          actions={[
            "Switch tabs: Monitor · Progress · Health · Runs",
            "Open any run from the Runs tab to inspect its timeline and cost",
          ]}
          shortcuts={[{ keys: "⌘K", desc: "Open the command palette" }]}
        />
      </header>

      <div className="overflow-x-auto">
        <Tabs tabs={TABS} value={tab} onChange={setTab} />
      </div>

      <div className="pt-5">
        {tab === "monitor" && <MonitorTab health={health} durations={durations} />}
        {tab === "progress" && (
          <ProgressTab
            throughput={throughput}
            durations={durations}
            loading={throughputQ.isLoading || durationsQ.isLoading}
          />
        )}
        {tab === "health" && <HealthTab health={health} />}
        {tab === "runs" && (
          <RunsTab
            durations={durations}
            loading={durationsQ.isLoading}
            isError={durationsQ.isError}
            onRetry={() => durationsQ.refetch()}
            nameById={nameById}
            onOpen={setRunId}
          />
        )}
      </div>

      <RunDetail open={!!runId} onClose={() => setRunId(null)} runId={runId} />
    </PageContainer>
  );
}

/* ── Monitor ──────────────────────────────────────────────────────────── */

function MonitorTab({
  health,
  durations,
}: {
  health: ProjectHealthRow[];
  durations: StepDurationRow[] | undefined;
}) {
  const totalOpen = health.reduce((a, h) => a + h.liveRuns, 0);
  const totalSpend = health.reduce((a, h) => a + h.spend24hUsd, 0);
  const totalActive = health.reduce((a, h) => a + h.totalActive, 0);
  const totalRunners = health.reduce((a, h) => a + h.runnerCount, 0);
  const recent = (durations ?? []).length;

  // A run row at running or paused is open work, not proof anything works it: "live" is said of sessions only.
  const open = health.filter((h) => h.liveRuns > 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Open runs" value={String(totalOpen)} />
        <Tile label="Spend · 24h" value={formatUsd(totalSpend)} />
        <Tile label={OPEN_WORK_LABEL} value={String(totalActive)} />
        <Tile label="Online runners" value={String(totalRunners)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Runs open now</CardTitle>
          <Stat icon="activity" mono={false}>
            {recent} steps finished · last 7d
          </Stat>
        </CardHeader>
        <CardContent>
          {open.length === 0 ? (
            <p className="fg-body-sm text-muted">No run is open right now.</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {open.map((h) => (
                <div key={h.id} className="flex items-center gap-3">
                  <span className="fg-body-sm flex-1 truncate font-medium text-fg">
                    {h.projectName}
                  </span>
                  <Badge tone="accent">{h.liveRuns} open</Badge>
                  <Stat icon="dollar">{formatUsd(h.spend24hUsd)}</Stat>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent>
        <p className="fg-caption">{label}</p>
        <p className="mt-1 font-mono text-2xl font-bold text-fg">{value}</p>
      </CardContent>
    </Card>
  );
}

/* ── Progress ─────────────────────────────────────────────────────────── */

interface StepAgg {
  step: string;
  count: number;
  avgSec: number;
  cost: number;
}

function aggregateByStep(durations: StepDurationRow[] | undefined): StepAgg[] {
  const m = new Map<string, { totalSec: number; count: number; cost: number }>();
  for (const r of durations ?? []) {
    const cur = m.get(r.step) ?? { totalSec: 0, count: 0, cost: 0 };
    cur.totalSec += r.durationSeconds;
    cur.count += 1;
    cur.cost += r.costUsd;
    m.set(r.step, cur);
  }
  return [...m.entries()]
    .map(([step, v]) => ({ step, count: v.count, avgSec: v.totalSec / v.count, cost: v.cost }))
    .sort((a, b) => b.avgSec - a.avgSec);
}

function ProgressTab({
  throughput,
  durations,
  loading,
}: {
  throughput: ThroughputRow[] | undefined;
  durations: StepDurationRow[] | undefined;
  loading: boolean;
}) {
  const shipped = (throughput ?? []).reduce((a, r) => a + r.count, 0);
  const aggs = useMemo(() => aggregateByStep(durations), [durations]);
  const maxAvg = Math.max(1, ...aggs.map((a) => a.avgSec));

  if (loading) {
    return (
      <div className="grid min-h-[30vh] place-items-center">
        <ProjectLoader label="loading progress…" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Tile label="Shipped · 30d" value={String(shipped)} />
        <Tile label="Steps · 7d" value={String((durations ?? []).length)} />
        <Tile
          label="Spend · 7d"
          value={formatUsd((durations ?? []).reduce((a, r) => a + r.costUsd, 0))}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Avg duration by stage · 7d</CardTitle>
        </CardHeader>
        <CardContent>
          {aggs.length === 0 ? (
            <p className="fg-body-sm text-muted">No completed steps in the window.</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {aggs.map((a) => (
                <div key={a.step} className="flex items-center gap-2.5">
                  <span className="w-28 flex-none break-words text-12 text-muted">{jobKindLabel(a.step)}</span>
                  <ProgressBar className="flex-1" value={(a.avgSec / maxAvg) * 100} />
                  <span className="w-20 flex-none text-right font-mono text-12 text-fg">
                    {formatDurationSec(a.avgSec)}
                  </span>
                  <span className="hidden w-14 flex-none text-right font-mono text-12 text-subtle sm:block">
                    {formatUsd(a.cost)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ── Health ───────────────────────────────────────────────────────────── */

function HealthTab({ health }: { health: ProjectHealthRow[] }) {
  if (health.length === 0) {
    return <EmptyState title="No projects" message="No project health to report." />;
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {health.map((h) => (
        <Card key={h.id}>
          <CardHeader>
            <CardTitle>{h.projectName}</CardTitle>
            <HealthDot health={deriveHealth(h)} />
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
              <Metric label={OPEN_WORK_LABEL} value={String(h.totalActive)} />
              <Metric label="Open runs" value={String(h.liveRuns)} />
              <Metric label="Runners" value={String(h.runnerCount)} />
              <Metric label="Spend · 24h" value={formatUsd(h.spend24hUsd)} />
              <Metric label="Blockers" value={String(h.blockers?.length ?? 0)} />
              <Metric label="Escalations" value={String(h.pendingEscalations)} />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="fg-caption">{label}</p>
      <p className="mt-0.5 font-mono text-sm font-semibold text-fg">{value}</p>
    </div>
  );
}

/* ── Runs ─────────────────────────────────────────────────────────────── */

function RunsTab({
  durations,
  loading,
  isError,
  onRetry,
  nameById,
  onOpen,
}: {
  durations: StepDurationRow[] | undefined;
  loading: boolean;
  isError: boolean;
  onRetry: () => void;
  nameById: Map<string, string>;
  onOpen: (runId: string) => void;
}) {
  if (loading) {
    return (
      <div className="grid min-h-[30vh] place-items-center">
        <ProjectLoader label="loading runs…" />
      </div>
    );
  }
  if (isError) return <ErrorState message="Failed to load runs." onRetry={onRetry} />;
  const rows = durations ?? [];
  if (rows.length === 0) {
    return <EmptyState title="No recent runs" message="No pipeline steps in the last 7 days." />;
  }

  return (
    <>
      {/* Mobile: stacked cards */}
      <div className="flex flex-col divide-y divide-line-subtle border-y border-line sm:hidden">
        {rows.map((r) => (
          <button
            type="button"
            key={`${r.runId}-${r.step}-${r.startedAt}`}
            onClick={() => onOpen(r.runId)}
            className="flex flex-col gap-1.5 py-3 text-left hover:bg-hover"
          >
            <div className="flex items-center gap-2">
              <span className="fg-body-sm text-fg">{jobKindLabel(r.step)}</span>
              <span className="fg-body-sm truncate text-fg">
                {nameById.get(r.projectId) ?? r.projectId.slice(0, 8)}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Stat icon="clock">{formatDurationSec(r.durationSeconds)}</Stat>
              <Stat icon="dollar">{formatUsd(r.costUsd)}</Stat>
            </div>
          </button>
        ))}
      </div>

      {/* Desktop: table */}
      <div className="hidden sm:block">
        <Table>
          <THead>
            <TR>
              <TH>Project</TH>
              <TH>Step</TH>
              <TH className="text-right">Duration</TH>
              <TH className="text-right">Cost</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((r) => (
              <TR
                key={`${r.runId}-${r.step}-${r.startedAt}`}
                className="cursor-pointer"
                onClick={() => onOpen(r.runId)}
              >
                <TD className="truncate">{nameById.get(r.projectId) ?? r.projectId.slice(0, 8)}</TD>
                <TD>
                  <span className="fg-body-sm text-fg">{jobKindLabel(r.step)}</span>
                </TD>
                <TD className="text-right font-mono">{formatDurationSec(r.durationSeconds)}</TD>
                <TD className="text-right font-mono">{formatUsd(r.costUsd)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
    </>
  );
}
