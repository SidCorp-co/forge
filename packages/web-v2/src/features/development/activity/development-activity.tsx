"use client";

// The engineers' figures and cards for one project: runs, runners, spend and open issues by state.
// They sat on the project Dashboard until it became the BA's page; the data is the same reads.

import { StatCell, StatRow, useNow } from "@/design";
import { formatUsd } from "@/features/pipeline/derive";
import { useProjectRuns, useStepDurations } from "@/features/pipeline/hooks";
import { useProjectHealth } from "@/features/projects/hooks";
import { useActiveRunners, useProjectRunners } from "@/features/runners/hooks";
import { useQueueStats } from "@/features/sessions/hooks";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { AwaitingRelease } from "./awaiting-release";
import { activeRuns, activeSpend, idleRuns, runnersSummary, spendByStage, statusDonut } from "./derive";
import { LiveRuns } from "./live-runs";
import { RunnerLoad } from "./runner-load";
import { SpendByStage } from "./spend-by-stage";
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
  const language = useInterfaceLanguage();

  const health = healthQ.data?.find((h) => h.projectSlug === slug);
  const runItems = runsQ.data?.items;
  const live = activeRuns(runItems);
  const inFlight = activeSpend(runItems);
  const runners = runnersSummary(projectRunnersQ.data, queueQ.data, language, anyLimited ? tick : Date.now(), activeRunnersQ.data?.runners);
  const donut = statusDonut(health?.statusDistribution);
  const t = useCopy();

  return (
    <section aria-label={t("overview.activity.aria")} className="space-y-4 px-5 pb-6 max-md:px-3" data-testid="development-activity">
      <StatRow>
        <StatCell
          label={t("overview.kpi.activeRuns")}
          value={live.length}
          tone={live.length > 0 ? "run" : undefined}
          hint={t("overview.kpi.runnersBusy", { busy: runners.busyCount, online: runners.onlineCount })}
        />
        <StatCell label={t("overview.kpi.openIssues")} value={health?.totalActive ?? donut.total} />
        <StatCell
          label={t("overview.kpi.spendToday")}
          value={formatUsd(health?.spend24hUsd ?? 0)}
          hint={inFlight > 0 ? t("overview.kpi.inFlight", { usd: formatUsd(inFlight) }) : t("overview.kpi.trailing")}
        />
      </StatRow>
      <div className="grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-2 xl:grid-cols-3">
        <LiveRuns runs={live} slug={slug} idle={idleRuns(runItems)} />
        <AwaitingRelease slug={slug} projectId={projectId} />
        <StatusDonut data={donut} />
        <SpendByStage data={spendByStage(durationsQ.data)} inFlightUsd={inFlight} />
        <RunnerLoad summary={runners} slug={slug} />
      </div>
    </section>
  );
}
