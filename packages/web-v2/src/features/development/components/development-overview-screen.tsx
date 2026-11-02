// Delivery overview (ISS-903 face): the signals strip, then one line per part, each a fold shut to its
// name and count (what needs you, runs and spend, the issue flow, what moves, what is held, what is
// stuck, the modules); Stuck alone opens on its own while anything is stuck. A partial read is one
// chip, why its hover. The one next act is Approvals while a decision waits.

import { CountSection, Disclosure, EmptyState, NextAction, PageTitle, StatusChip } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { DevelopmentActivity } from "../activity/development-activity";
import { useDevelopmentOverview } from "../hooks";
import type { DevelopmentOverview } from "../types";
import { IssueFlow } from "./issue-flow";
import { LeaseLanes } from "./lease-lanes";
import { ModuleBars } from "./module-bars";
import { NEEDS_YOU_PERSON_CAP } from "@forge/contracts/steward";
import { DecisionList, NeedsYouList, useNeedsYou, useNeedsYouDecisions } from "@/features/needs-you";
import { approvalsHref } from "@/lib/routes/approvals";
import { DevelopmentSignals } from "./development-signals";
import { DeliveryHolds } from "./delivery-holds";
import { StuckChains } from "./stuck-chains";

function Coverage({ c }: { c: DevelopmentOverview["coverage"] }) {
  const t = useCopy();
  if (c.openRead >= c.open && !c.flowTruncated) return null;
  return (
    <p className="flex px-5 max-md:px-3">
      <StatusChip
        tone="blocked"
        label={t("overview.dev.partial")}
        reason={c.openRead < c.open ? t("overview.dev.partialOpen", { read: c.openRead, open: c.open }) : t("overview.dev.partialFlow", { limit: c.limit })}
        testId="overview-partial"
      />
    </p>
  );
}

export function DevelopmentOverviewScreen({ scope }: { scope: { projectId: string; slug: string } }) {
  const q = useDevelopmentOverview(scope.projectId);
  // the decisions are the one decisions read, three at a time with the rest counted, as the Dashboard
  // draws them (REQ-68 BC-3); the ops rows that are no decision are listed under them
  const decisions = useNeedsYouDecisions(scope.projectId).data;
  const opsRows = (useNeedsYou(scope.projectId).data?.items ?? []).filter((n) => n.space !== "asks");
  const t = useCopy();
  const waiting = decisions?.total ?? 0;
  return (
    <>
      <PageTitle>{t("overview.dev.title")}</PageTitle>
      {waiting > 0 ? <NextAction label={t("approvals.title")} href={approvalsHref(scope.slug)} testId="overview-next" /> : null}
      <div className="flex min-h-full flex-col gap-4 bg-app pb-8" data-testid="development-overview">
        <QueryBoundary query={q} loadingLabel={t("overview.dev.loading")} height="50vh" retry="always">
          {(d) => (
            <>
              <DevelopmentSignals data={d} />
              <Coverage c={d.coverage} />
              {d.flow.total === 0 && waiting === 0 && opsRows.length === 0 && d.stuck.count === 0 && d.moving.count === 0 && d.holds.count === 0 ? (
                <EmptyState message={t("overview.dev.emptyTitle")} />
              ) : null}
              <div className="px-5 max-md:px-3">
                <CountSection label={t("issues.attention.needs_you")} count={waiting + opsRows.length} testId="needs-you" highlight="needs-you">
                  {decisions ? <DecisionList read={decisions} slug={scope.slug} cap={NEEDS_YOU_PERSON_CAP} moreHref={approvalsHref(scope.slug)} /> : null}
                  {opsRows.length > 0 ? (
                    <NeedsYouList items={opsRows} slug={scope.slug} foldKey="web-v2:development-overview:fold" empty={t("overview.dev.needsYouEmpty")} />
                  ) : null}
                </CountSection>
                <CountSection label={t("issues.attention.stuck")} count={d.stuck.count} defaultOpen testId="overview-stuck">
                  <StuckChains stuck={d.stuck} slug={scope.slug} />
                </CountSection>
                <CountSection label={t("overview.hold.title")} count={d.holds.count} testId="overview-held">
                  <DeliveryHolds holds={d.holds} slug={scope.slug} />
                </CountSection>
                <CountSection label={t("issues.attention.moving")} count={d.moving.count} testId="overview-moving">
                  <LeaseLanes moving={d.moving} slug={scope.slug} />
                </CountSection>
                <CountSection label={t("overview.dev.flow")} count={d.flow.total} note={t("overview.dev.flowDays", { days: d.flow.windowDays })} testId="overview-flow">
                  <IssueFlow flow={d.flow} />
                </CountSection>
                <Disclosure title={t("overview.dev.modules")} testId="overview-modules">
                  <ModuleBars modules={d.modules} />
                </Disclosure>
                <Disclosure title={t("overview.activity.aria")} testId="overview-activity">
                  <DevelopmentActivity projectId={scope.projectId} slug={scope.slug} />
                </Disclosure>
              </div>
            </>
          )}
        </QueryBoundary>
      </div>
    </>
  );
}
