"use client";

import { EmptyState, PageTitle, ViewHeading, WaitBanner } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { DevelopmentActivity } from "../activity/development-activity";
import { useDevelopmentOverview } from "../hooks";
import type { DevelopmentOverview } from "../types";
import { IssueFlow } from "./issue-flow";
import { LeaseLanes } from "./lease-lanes";
import { ModuleBars } from "./module-bars";
import { NeedsYouList } from "@/features/needs-you/components/needs-you-list";
import { useNeedsYou } from "@/features/needs-you/hooks";
import { SignalsStrip } from "./signals-strip";
import { StuckChains } from "./stuck-chains";

const Count = ({ n }: { n: number }) => <span className="font-mono tabular-nums">{n}</span>;

const Note = ({ children }: { children: string }) => <span className="text-12-5 font-normal text-muted">{children}</span>;

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
  const needsYou = useNeedsYou(scope.projectId).data?.items ?? [];
  const t = useCopy();
  return (
    <>
      <PageTitle hint={t("overview.dev.hint")}>{t("overview.dev.title")}</PageTitle>
      <div className="flex min-h-full flex-col bg-app pb-8" data-testid="development-overview">
        <QueryBoundary query={q} loadingLabel={t("overview.dev.loading")} height="50vh" retry="always">
          {(d) => (
            <>
              <SignalsStrip data={d} />
              <div className="pt-6">
                <DevelopmentActivity projectId={scope.projectId} slug={scope.slug} />
              </div>
              <Coverage c={d.coverage} />
              <div className="grid gap-x-14 gap-y-9 px-5 py-6 max-md:px-3 lg:grid-cols-2">
                <div className="min-w-0 space-y-9">
                  <section aria-label={t("overview.dev.flow")}>
                    <ViewHeading right={<Note>{t("overview.dev.flowNote", { days: d.flow.windowDays, n: d.flow.total })}</Note>}>{t("overview.dev.flow")}</ViewHeading>
                    <IssueFlow flow={d.flow} />
                  </section>
                  <section aria-label={t("issues.attention.moving")}>
                    <ViewHeading right={<Note>{t("overview.dev.movingNote")}</Note>}>
                      {t("issues.attention.moving")} <Count n={d.moving.count} />
                    </ViewHeading>
                    <LeaseLanes moving={d.moving} slug={scope.slug} />
                  </section>
                </div>
                <div className="min-w-0 space-y-9">
                  <section aria-label={t("issues.attention.stuck")}>
                    <ViewHeading right={<Note>{t("overview.dev.stuckNote")}</Note>}>
                      {t("issues.attention.stuck")} <Count n={d.stuck.count} />
                    </ViewHeading>
                    <StuckChains stuck={d.stuck} slug={scope.slug} />
                  </section>
                  <section aria-label={t("overview.dev.modules")}>
                    <ViewHeading right={<Note>{t("overview.dev.modulesNote")}</Note>}>{t("overview.dev.modules")}</ViewHeading>
                    <ModuleBars modules={d.modules} />
                  </section>
                </div>
              </div>
              {d.flow.total === 0 && needsYou.length === 0 && d.stuck.count === 0 && d.moving.count === 0 ? (
                <EmptyState title={t("overview.dev.emptyTitle")} message={t("overview.dev.emptyBody")} />
              ) : null}
              <section id="needs-you" aria-label={t("issues.attention.needs_you")} className="scroll-mt-4" data-testid="needs-you">
                <NeedsYouList
                  items={needsYou}
                  slug={scope.slug}
                  foldKey="web-v2:development-overview:fold"
                  empty={t("overview.dev.needsYouEmpty")}
                />
              </section>
            </>
          )}
        </QueryBoundary>
      </div>
    </>
  );
}
