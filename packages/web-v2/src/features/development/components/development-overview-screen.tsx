
import { EmptyState, PageTitle, Section, WaitBanner } from "@/design";
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

const Count = ({ n }: { n: number }) => <span className="font-mono tabular-nums">{n}</span>;

const Note = ({ children }: { children: string }) => <span className="text-13 font-normal text-muted">{children}</span>;

function Coverage({ c }: { c: DevelopmentOverview["coverage"] }) {
  const t = useCopy();
  if (c.openRead >= c.open && !c.flowTruncated) return null;
  return (
    <WaitBanner
      tone="calm"
      head={t("overview.dev.partialHead")}
      body={c.openRead < c.open ? t("overview.dev.partialOpen", { read: c.openRead, open: c.open }) : t("overview.dev.partialFlow", { limit: c.limit })}
      className="border-b border-line-subtle"
      testId="overview-partial"
    />
  );
}

export function DevelopmentOverviewScreen({ scope }: { scope: { projectId: string; slug: string } }) {
  const q = useDevelopmentOverview(scope.projectId);
  // the decisions are the one decisions read, three at a time with the rest counted, as the Dashboard
  // draws them (REQ-68 BC-3); the ops rows that are no decision are listed under them
  const decisions = useNeedsYouDecisions(scope.projectId).data;
  const opsRows = (useNeedsYou(scope.projectId).data?.items ?? []).filter((n) => n.space !== "asks");
  const t = useCopy();
  return (
    <>
      <PageTitle>{t("overview.dev.title")}</PageTitle>
      <div className="flex min-h-full flex-col bg-app pb-8" data-testid="development-overview">
        <QueryBoundary query={q} loadingLabel={t("overview.dev.loading")} height="50vh" retry="always">
          {(d) => (
            <>
              <DevelopmentSignals data={d} />
              <div className="pt-6">
                <DevelopmentActivity projectId={scope.projectId} slug={scope.slug} />
              </div>
              <Coverage c={d.coverage} />
              <div className="grid gap-x-14 gap-y-9 px-5 py-6 max-md:px-3 lg:grid-cols-2">
                <div className="min-w-0">
                  <Section title={t("overview.dev.flow")} right={<Note>{t("overview.dev.flowNote", { days: d.flow.windowDays, n: d.flow.total })}</Note>}>
                    <IssueFlow flow={d.flow} />
                  </Section>
                  <Section title={t("issues.attention.moving")} right={<Count n={d.moving.count} />}>
                    <LeaseLanes moving={d.moving} slug={scope.slug} />
                  </Section>
                </div>
                <div className="min-w-0">
                  <Section title={t("overview.hold.title")} right={<Count n={d.holds.count} />}>
                    <DeliveryHolds holds={d.holds} slug={scope.slug} />
                  </Section>
                  <Section title={t("issues.attention.stuck")} right={<Count n={d.stuck.count} />}>
                    <StuckChains stuck={d.stuck} slug={scope.slug} />
                  </Section>
                  <Section title={t("overview.dev.modules")}>
                    <ModuleBars modules={d.modules} />
                  </Section>
                </div>
              </div>
              {d.flow.total === 0 && (decisions?.total ?? 0) === 0 && opsRows.length === 0 && d.stuck.count === 0 && d.moving.count === 0 && d.holds.count === 0 ? (
                <EmptyState message={t("overview.dev.emptyTitle")} />
              ) : null}
              <section id="needs-you" aria-label={t("issues.attention.needs_you")} className="scroll-mt-4" data-testid="needs-you">
                {decisions ? (
                  <DecisionList read={decisions} slug={scope.slug} cap={NEEDS_YOU_PERSON_CAP} moreHref={approvalsHref(scope.slug)} />
                ) : null}
                {opsRows.length > 0 ? (
                  <NeedsYouList items={opsRows} slug={scope.slug} foldKey="web-v2:development-overview:fold" empty={t("overview.dev.needsYouEmpty")} />
                ) : null}
              </section>
            </>
          )}
        </QueryBoundary>
      </div>
    </>
  );
}
