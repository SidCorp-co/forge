
// Ops monitor (`/ops`, ISS-295) — ONE tabbed surface (Monitor / Progress /
// Health / Runs) collapsing the old /pipeline,/progress,/health,/runs into a
// single Tabs view on real cross-project data. Live via WS: cross-project
// events only arrive on subscribed rooms, so we fan out a `useRoom` per project
// (bounded list) — `pipeline_run.status_changed` then refreshes
// `['projects','health']` + `['pipeline-runs','list']`.
import {
  Badge,
  EmptyState,
  HealthDot,
  MonoTag,
  PageContainer,
  PageTitle,
  ProgressBar,
  Stat,
  Table,
  Tabs,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useUrlChoice,
  useUrlParams,
  Section,
  StatCell,
  StatRow,
} from "@/design";
import { deriveHealth, type ProjectHealthRow, useOrgScopedProjects, useProjectHealth } from "@/features/projects";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useStepDurations, useThroughput } from "../hooks";
import type { StepDurationRow, ThroughputRow } from "../types";
import { RunDetail } from "./run-detail";
import { formatDurationSec, formatUsd } from "@/lib/i18n/format";


const TAB_VALUES = ["monitor", "progress", "health", "runs"] as const;
type OpsTab = (typeof TAB_VALUES)[number];

/** Subscribes to one WS room for its lifetime (renders nothing). Lets us fan
 *  out room subscriptions over a list without breaking the rules-of-hooks. */
function RoomSub({ room }: { room: string }) {
  useRoom(room);
  return null;
}

export function OpsMonitor() {
  const t = useCopy();
  // The tab and the open run live in the URL, so `/ops?run=<id>` is a shareable deep link.
  const [tab, setTab] = useUrlChoice<OpsTab>("tab", TAB_VALUES, "monitor");
  const [params, setParams] = useUrlParams();
  const runId = params.get("run");
  const setRunId = (id: string | null) => setParams({ run: id });

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

  const health = (healthQ.data ?? []).filter((h) => projectIds.has(h.id));
  const inOrg = <R extends { projectId: string }>(rows: R[]) => rows.filter((r) => projectIds.has(r.projectId));
  const scoped = { isLoading: projectsLoading || healthQ.isLoading, isError: !!projectsError || healthQ.isError, error: projectsError ?? healthQ.error, data: healthQ.data, refetch: healthQ.refetch };
  const nameById = (() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.name);
    for (const h of health) if (!m.has(h.id)) m.set(h.id, h.projectName);
    return m;
  })();

  return (
    <PageContainer className="flex min-h-dvh flex-col">
      {/* Cross-project live fan-out */}
      {projects.map((p) => (
        <RoomSub key={p.id} room={projectRoom(p.id)} />
      ))}

      <PageTitle>{t("pipeline.ops.title")}</PageTitle>

      <div className="overflow-x-auto">
        <Tabs tabs={TAB_VALUES.map((value) => ({ value, label: t(`pipeline.ops.tab.${value}`) }))} value={tab} onChange={(v) => setTab(v as OpsTab)} />
      </div>

      <div className="pt-5">
        <QueryBoundary query={scoped} loadingLabel={t("pipeline.ops.loading")} height="60vh">
          {() => (
            <>
              {tab === "monitor" && <MonitorTab health={health} durations={inOrg(durationsQ.data ?? [])} />}
              {tab === "health" && <HealthTab health={health} />}
              {tab === "progress" && (
                <QueryBoundary query={durationsQ} loadingLabel={t("pipeline.ops.loadingProgress")} height="30vh">
                  {(d) => <ProgressTab throughput={inOrg(throughputQ.data ?? [])} durations={inOrg(d)} />}
                </QueryBoundary>
              )}
              {tab === "runs" && (
                <QueryBoundary query={durationsQ} loadingLabel={t("pipeline.ops.loadingRuns")} height="30vh">
                  {(d) => <RunsTab durations={inOrg(d)} nameById={nameById} onOpen={setRunId} />}
                </QueryBoundary>
              )}
            </>
          )}
        </QueryBoundary>
      </div>

      <RunDetail open={!!runId} onClose={() => setRunId(null)} issue={null} runId={runId} />
    </PageContainer>
  );
}

function MonitorTab({ health, durations }: { health: ProjectHealthRow[]; durations: StepDurationRow[] }) {
  const sum = (of: (h: ProjectHealthRow) => number) => health.reduce((a, h) => a + of(h), 0);
  const live = health.filter((h) => h.liveRuns > 0);
  const t = useCopy();
  return (
    <div className="flex flex-col gap-5">
      <StatRow>
        <StatCell label={t("pipeline.ops.liveRuns")} value={sum((h) => h.liveRuns)} />
        <StatCell label={t("pipeline.ops.spend24h")} value={formatUsd(sum((h) => h.spend24hUsd))} />
        <StatCell label={t("pipeline.ops.activeIssues")} value={sum((h) => h.totalActive)} />
        <StatCell label={t("pipeline.ops.onlineRunners")} value={sum((h) => h.runnerCount)} />
      </StatRow>
      <Section title={t("pipeline.ops.liveNow")} right={<Stat icon="activity" mono={false}>{t("pipeline.ops.steps7d", { n: durations.length })}</Stat>}>
        {live.length === 0 ? (
          <p className="fg-body-sm text-muted">{t("pipeline.ops.nothingLive")}</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {live.map((h) => (
              <div key={h.id} className="flex items-center gap-3">
                <span className="fg-body-sm flex-1 truncate font-medium text-fg">{h.projectName}</span>
                <Badge tone="accent">{t("pipeline.ops.liveCount", { n: h.liveRuns })}</Badge>
                <Stat icon="dollar">{formatUsd(h.spend24hUsd)}</Stat>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function aggregateByStep(durations: StepDurationRow[]) {
  const m = new Map<string, { totalSec: number; count: number; cost: number }>();
  for (const r of durations) {
    const cur = m.get(r.step) ?? { totalSec: 0, count: 0, cost: 0 };
    m.set(r.step, { totalSec: cur.totalSec + r.durationSeconds, count: cur.count + 1, cost: cur.cost + r.costUsd });
  }
  return [...m.entries()].map(([step, v]) => ({ step, avgSec: v.totalSec / v.count, cost: v.cost })).sort((a, b) => b.avgSec - a.avgSec);
}

function ProgressTab({ throughput, durations }: { throughput: ThroughputRow[]; durations: StepDurationRow[] }) {
  const aggs = aggregateByStep(durations);
  const maxAvg = Math.max(1, ...aggs.map((a) => a.avgSec));
  const t = useCopy();
  return (
    <div className="flex flex-col gap-5">
      <StatRow>
        <StatCell label={t("pipeline.ops.shipped30d")} value={throughput.reduce((a, r) => a + r.count, 0)} />
        <StatCell label={t("pipeline.ops.stepsWeek")} value={durations.length} />
        <StatCell label={t("pipeline.ops.spend7d")} value={formatUsd(durations.reduce((a, r) => a + r.costUsd, 0))} />
      </StatRow>
      <Section title={t("pipeline.ops.avgByStage")}>
        {aggs.length === 0 ? (
          <p className="fg-body-sm text-muted">{t("pipeline.ops.noSteps")}</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {aggs.map((a) => (
              <div key={a.step} className="flex items-center gap-2.5">
                <span className="w-16 flex-none font-mono text-12 text-muted">{a.step}</span>
                <ProgressBar className="flex-1" value={(a.avgSec / maxAvg) * 100} />
                <span className="w-20 flex-none text-right font-mono text-12 text-fg">{formatDurationSec(a.avgSec)}</span>
                <span className="hidden w-14 flex-none text-right font-mono text-12 text-subtle sm:block">{formatUsd(a.cost)}</span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function HealthTab({ health }: { health: ProjectHealthRow[] }) {
  const t = useCopy();
  if (health.length === 0) return <EmptyState message={t("pipeline.ops.noProjects")} />;
  return (
    <div className="flex flex-col gap-2">
      {health.map((h) => (
        <Section title={h.projectName} right={<HealthDot health={deriveHealth(h)} />} key={h.id}>
          <StatRow>
            <StatCell label={t("pipeline.ops.active")} value={h.totalActive} />
            <StatCell label={t("pipeline.ops.liveRuns")} value={h.liveRuns} />
            <StatCell label={t("pipeline.ops.runners")} value={h.runnerCount} />
            <StatCell label={t("pipeline.ops.spend24h")} value={formatUsd(h.spend24hUsd)} />
            <StatCell label={t("pipeline.ops.blockers")} value={h.blockers?.length ?? 0} />
            <StatCell label={t("pipeline.ops.escalations")} value={h.pendingEscalations} />
          </StatRow>
        </Section>
      ))}
    </div>
  );
}

function RunsTab({ durations, nameById, onOpen }: { durations: StepDurationRow[]; nameById: Map<string, string>; onOpen: (runId: string) => void }) {
  const t = useCopy();
  if (durations.length === 0) return <EmptyState message={t("pipeline.ops.noRuns")} />;
  return (
    <Table>
      <THead>
        <TR>
          <TH>{t("pipeline.ops.colProject")}</TH>
          <TH>{t("pipeline.ops.colStep")}</TH>
          <TH className="text-right">{t("pipeline.ops.colDuration")}</TH>
          <TH className="text-right">{t("pipeline.ops.colCost")}</TH>
        </TR>
      </THead>
      <TBody>
        {durations.map((r) => (
          <TR key={`${r.runId}-${r.step}-${r.startedAt}`} className="cursor-pointer" onClick={() => onOpen(r.runId)}>
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
  );
}
