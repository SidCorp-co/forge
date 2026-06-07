"use client";

// Ops monitor (`/ops`, ISS-295) — ONE tabbed surface (Monitor / Progress /
// Health / Runs) collapsing the old /pipeline,/progress,/health,/runs into a
// single Tabs view on real cross-project data. Live via WS: cross-project
// events only arrive on subscribed rooms, so we fan out a `useRoom` per project
// (bounded list) — `pipeline_run.status_changed` then refreshes
// `['projects','health']` + `['pipeline-runs','list']`.
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
  MonoTag,
  ProgressBar,
  ProjectLoader,
  Stat,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Tabs,
} from "@/design";
import { deriveHealth } from "@/features/projects/derive";
import { useProjectHealth, useProjects } from "@/features/projects/hooks";
import type { ProjectHealthRow } from "@/features/projects/types";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { formatDurationSec, formatUsd } from "../derive";
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

  const projectsQ = useProjects();
  const healthQ = useProjectHealth();
  const durationsQ = useStepDurations({ days: 7 });
  const throughputQ = useThroughput({ days: 30 });

  const projects = projectsQ.data ?? [];
  const health = healthQ.data ?? [];
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.name);
    for (const h of health) if (!m.has(h.id)) m.set(h.id, h.projectName);
    return m;
  }, [projects, health]);

  if (projectsQ.isLoading || healthQ.isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading ops…" />
      </div>
    );
  }
  if (projectsQ.isError || healthQ.isError) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState
          message={formatApiError(projectsQ.error ?? healthQ.error)}
          onRetry={() => {
            projectsQ.refetch();
            healthQ.refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 py-6 sm:px-6">
      {/* Cross-project live fan-out */}
      {projects.map((p) => (
        <RoomSub key={p.id} room={projectRoom(p.id)} />
      ))}

      <header className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="fg-h2">Ops</h1>
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
        {tab === "monitor" && <MonitorTab health={health} durations={durationsQ.data} />}
        {tab === "progress" && (
          <ProgressTab
            throughput={throughputQ.data}
            durations={durationsQ.data}
            loading={throughputQ.isLoading || durationsQ.isLoading}
          />
        )}
        {tab === "health" && <HealthTab health={health} />}
        {tab === "runs" && (
          <RunsTab
            durations={durationsQ.data}
            loading={durationsQ.isLoading}
            isError={durationsQ.isError}
            onRetry={() => durationsQ.refetch()}
            nameById={nameById}
            onOpen={setRunId}
          />
        )}
      </div>

      <RunDetail open={!!runId} onClose={() => setRunId(null)} issue={null} runId={runId} />
    </div>
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
  const totalLive = health.reduce((a, h) => a + h.liveRuns, 0);
  const totalSpend = health.reduce((a, h) => a + h.spend24hUsd, 0);
  const totalActive = health.reduce((a, h) => a + h.totalActive, 0);
  const totalRunners = health.reduce((a, h) => a + h.runnerCount, 0);
  const recent = (durations ?? []).length;

  const live = health.filter((h) => h.liveRuns > 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Live runs" value={String(totalLive)} />
        <Tile label="Spend · 24h" value={formatUsd(totalSpend)} />
        <Tile label="Active issues" value={String(totalActive)} />
        <Tile label="Online runners" value={String(totalRunners)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Live now</CardTitle>
          <Stat icon="activity" mono={false}>
            {recent} steps · last 7d
          </Stat>
        </CardHeader>
        <CardContent>
          {live.length === 0 ? (
            <p className="fg-body-sm text-muted">No runs are active right now.</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {live.map((h) => (
                <div key={h.id} className="flex items-center gap-3">
                  <span className="fg-body-sm flex-1 truncate font-medium text-fg">
                    {h.projectName}
                  </span>
                  <Badge tone="accent">{h.liveRuns} live</Badge>
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
  const closed = (throughput ?? []).reduce((a, r) => a + r.count, 0);
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
        <Tile label="Closed · 30d" value={String(closed)} />
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
                  <span className="w-16 flex-none font-mono text-[12px] text-muted">{a.step}</span>
                  <ProgressBar className="flex-1" value={(a.avgSec / maxAvg) * 100} />
                  <span className="w-20 flex-none text-right font-mono text-[12px] text-fg">
                    {formatDurationSec(a.avgSec)}
                  </span>
                  <span className="hidden w-14 flex-none text-right font-mono text-[12px] text-subtle sm:block">
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
              <Metric label="Active" value={String(h.totalActive)} />
              <Metric label="Live runs" value={String(h.liveRuns)} />
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
      <div className="flex flex-col gap-2.5 sm:hidden">
        {rows.map((r, i) => (
          <button
            type="button"
            key={`${r.runId}-${r.step}-${i}`}
            onClick={() => onOpen(r.runId)}
            className="flex flex-col gap-1.5 rounded-md border border-line bg-surface p-3 text-left hover:bg-hover"
          >
            <div className="flex items-center gap-2">
              <MonoTag>{r.step}</MonoTag>
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
            {rows.map((r, i) => (
              <TR
                key={`${r.runId}-${r.step}-${i}`}
                className="cursor-pointer"
                onClick={() => onOpen(r.runId)}
              >
                <TD className="truncate">{nameById.get(r.projectId) ?? r.projectId.slice(0, 8)}</TD>
                <TD>
                  <MonoTag>{r.step}</MonoTag>
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
