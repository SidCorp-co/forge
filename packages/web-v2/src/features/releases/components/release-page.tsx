"use client";

import { RELEASE_PAGE_VIEWS, type ReleasePageViewKind } from "@forge/contracts/release-page";
import {
  DetailLayout,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  FactsRail,
  SegmentedControl,
  StatusBadge,
  useUrlChoice,
  useUrlTab,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { TourHint } from "@/features/tours/components/tour-hint";
import { useDraftReleaseForecast } from "@/features/forecast/hooks";
import { useRelease, useReleasePage, useReleases } from "../hooks";
import { ContinuedAs, EndedAttempt } from "./release-attempts";
import { ReleaseBanner } from "./release-bits";
import { ChecksPane } from "./release-checks";
import { ReleaseFacts, ReleasePhoneStanding } from "./release-facts";
import { ReleasePageActions } from "./release-page-actions";
import { ReleaseReader } from "./release-reader";
import { CriteriaPane, IssuesPane, NotesPane, OverviewPane, RELEASE_TABS, type ReleaseTab } from "./release-panes";

const LABEL: Record<ReleaseTab, ProductCopyKey> = {
  overview: "releases.tab.overview",
  issues: "releases.tab.issues",
  criteria: "releases.tab.criteria",
  checks: "releases.tab.checks",
  notes: "releases.tab.notes",
};

/** The release as a reader reads it, in the view the person chose; the switch and the share and export acts sit above it. */
function ReaderPane({ projectId, slug, version, view }: { projectId: string; slug: string; version: string; view: ReleasePageViewKind }) {
  const t = useCopy();
  const q = useReleasePage(projectId, version, view);
  return (
    <DetailPane label={t("releases.page.loading")} testId="release-page-reader">
      <QueryBoundary query={q} loadingLabel={t("releases.page.loading")}>
        {(page) => (
          <div className="grid gap-5">
            <ReleasePageActions projectId={projectId} page={page} />
            <ReleaseReader page={page} slug={slug} authed />
          </div>
        )}
      </QueryBoundary>
    </DetailPane>
  );
}

export function ReleasePage({ projectId, slug, version }: { projectId: string; slug: string; version: string }) {
  const t = useCopy();
  const [tab, onTab] = useUrlTab(RELEASE_TABS);
  const [view, onView] = useUrlChoice<ReleasePageViewKind>("view", RELEASE_PAGE_VIEWS, "user");
  const q = useRelease(projectId, version);
  const forecastQ = useDraftReleaseForecast(projectId, q.data?.release.state === "draft");
  const list = useReleases(projectId);
  return (
    <QueryBoundary query={q} loadingLabel={t("releases.loadingOne")}>
      {(data) => {
        const r = data.release;
        const tabs = [
          { value: "overview" as const, label: t(LABEL.overview) },
          { value: "issues" as const, label: t(LABEL.issues), count: r.issues.length },
          { value: "criteria" as const, label: t(LABEL.criteria), count: r.criteria.total },
          { value: "checks" as const, label: t(LABEL.checks), count: r.cuts.length + r.attempts.length + r.approvals.length },
          { value: "notes" as const, label: t(LABEL.notes) },
        ];
        const operator =
          tab === "issues" ? (
            <IssuesPane r={r} slug={slug} />
          ) : (
            <DetailPane label={t(LABEL[tab])}>
              {tab === "overview" ? <OverviewPane r={r} slug={slug} all={list.data?.releases ?? [r]} /> : null}
              {tab === "criteria" ? <CriteriaPane r={r} /> : null}
              {tab === "checks" ? <ChecksPane r={r} slug={slug} /> : null}
              {tab === "notes" ? <NotesPane r={r} slug={slug} /> : null}
            </DetailPane>
          );
        return (
          <DetailLayout
            testId="release-detail"
            dataKey={r.key}
            rail={
              <FactsRail>
                <ReleaseFacts r={r} forecast={forecastQ.data} />
              </FactsRail>
            }
          >
            <DetailMobileTitle title={t("releases.releaseVersion", { version: r.version })} badge={<StatusBadge family="releaseState" value={r.state} />} />
            <ReleaseBanner r={r} className="px-8 py-2.5 max-md:px-4" />
            <EndedAttempt r={r} slug={slug} />
            {r.continuedAs ? <ContinuedAs to={r.continuedAs} slug={slug} className="border-b border-line-subtle px-8 py-2 max-md:px-4" /> : null}
            <ReleasePhoneStanding r={r} forecast={forecastQ.data} />
            <TourHint tourId="release-what-changes" />
            <div className="flex items-center gap-3 border-b border-line-subtle px-8 py-2.5 max-md:px-4" data-testid="release-view-bar">
              <span data-tour="rel-technical" data-testid="release-view-switch" title={t("releases.page.view.label")}>
                <SegmentedControl
                  options={RELEASE_PAGE_VIEWS.map((v) => ({ value: v, label: t(`releases.page.view.${v}`) }))}
                  value={view}
                  onChange={onView}
                />
              </span>
            </div>
            <ReaderPane projectId={projectId} slug={slug} version={r.version} view={view} />
            {view === "developer" ? (
              <>
                <DetailTabs tabs={tabs} value={tab} onChange={onTab} testId="release-tabs" />
                {operator}
              </>
            ) : null}
          </DetailLayout>
        );
      }}
    </QueryBoundary>
  );
}
