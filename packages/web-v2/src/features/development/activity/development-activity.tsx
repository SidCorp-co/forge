"use client";

// The engineers' figures and cards for one project: runs, runners, spend and open issues by state.
// They sat on the project Dashboard until it became the BA's page; the data is the same reads.

import { useNow } from "@/design";
import { useProjectRuns, useStepDurations } from "@/features/pipeline/hooks";
import { useProjectHealth } from "@/features/projects/hooks";
import { useActiveRunners, useProjectRunners } from "@/features/runners/hooks";
import { useQueueStats } from "@/features/sessions/hooks";
import { AwaitingReleaseCard } from "./awaiting-release-card";
import { activeRuns, activeSpend, awaitingReleaseRuns, idleRuns, runnersSummary, spendByStage, statusDonut } from "./derive";
import { KpiBand } from "./kpi-band";
import { LiveRunsCard } from "./live-runs-card";
import { RunnersCard } from "./runners-card";
import { SpendCard } from "./spend-card";
import { StatusDonut } from "./status-donut";

export function DevelopmentActivity({ projectId, slug }: { projectId: string; slug: string }) {
  const healthQ = useProjectHealth();
  const runsQ = useProjectRuns(projectId);
  const durationsQ = useStepDurations({ days: 7, projectId });
  const queueQ = useQueueStats(projectId);
  const projectRunnersQ = useProjectRunners(projectId);
  const activeRunnersQ = useActiveRunners(projectId);

  // Tick once a second while some runner is limited, so its countdown to the next try stays live
  // (the next try, never the reset its account printed: ISS-276).
  const anyLimited = (projectRunnersQ.data ?? []).some((r) => r.limitReason);
  const tick = useNow(1000, anyLimited);

  const health = healthQ.data?.find((h) => h.projectSlug === slug);
  const runItems = runsQ.data?.items;
  const live = activeRuns(runItems);
  const inFlight = activeSpend(runItems);
  const runners = runnersSummary(projectRunnersQ.data, queueQ.data, anyLimited ? tick : Date.now(), activeRunnersQ.data?.runners);
  const donut = statusDonut(health?.statusDistribution);

  return (
    <section aria-label="Runs, runners and spend" className="space-y-4 px-5 pb-6 max-md:px-3" data-testid="development-activity">
      <KpiBand
        liveRuns={live.length}
        busyRunners={runners.busyCount}
        onlineRunners={runners.onlineCount}
        openIssues={health?.totalActive ?? donut.total}
        spendTodayUsd={health?.spend24hUsd ?? 0}
        inFlightUsd={inFlight}
      />
      <div className="grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-2 xl:grid-cols-3">
        <LiveRunsCard runs={live} slug={slug} idle={idleRuns(runItems)} />
        <AwaitingReleaseCard runs={awaitingReleaseRuns(runItems)} slug={slug} projectId={projectId} />
        <StatusDonut data={donut} />
        <SpendCard data={spendByStage(durationsQ.data)} inFlightUsd={inFlight} />
        <RunnersCard summary={runners} slug={slug} />
      </div>
    </section>
  );
}
