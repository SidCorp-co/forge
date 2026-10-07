"use client";

import {
  DetailLayout,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  FactsRail,
  StatusBadge,
  useUrlTab,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useDraftReleaseForecast } from "@/features/forecast/hooks";
import { useRelease, useReleases } from "../hooks";
import { ReleaseBanner } from "./release-bits";
import { ChecksPane } from "./release-checks";
import { ReleaseFacts, ReleasePhoneStanding } from "./release-facts";
import { CriteriaPane, IssuesPane, NotesPane, OverviewPane, RELEASE_TABS, type ReleaseTab } from "./release-panes";

const LABEL: Record<ReleaseTab, ProductCopyKey> = {
  overview: "releases.tab.overview",
  issues: "releases.tab.issues",
  criteria: "releases.tab.criteria",
  checks: "releases.tab.checks",
  notes: "releases.tab.notes",
};

export function ReleasePage({ projectId, slug, version }: { projectId: string; slug: string; version: string }) {
  const t = useCopy();
  const [tab, onTab] = useUrlTab(RELEASE_TABS);
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
          { value: "checks" as const, label: t(LABEL.checks), count: r.attempts.length + r.approvals.length },
          { value: "notes" as const, label: t(LABEL.notes) },
        ];
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
            <ReleasePhoneStanding r={r} forecast={forecastQ.data} />
            <DetailTabs tabs={tabs} value={tab} onChange={onTab} testId="release-tabs" />
            {tab === "issues" ? (
              <IssuesPane r={r} slug={slug} />
            ) : (
              <DetailPane label={t(LABEL[tab])}>
                {tab === "overview" ? <OverviewPane r={r} slug={slug} all={list.data?.releases ?? [r]} /> : null}
                {tab === "criteria" ? <CriteriaPane r={r} /> : null}
                {tab === "checks" ? <ChecksPane r={r} /> : null}
                {tab === "notes" ? <NotesPane r={r} slug={slug} /> : null}
              </DetailPane>
            )}
          </DetailLayout>
        );
      }}
    </QueryBoundary>
  );
}
