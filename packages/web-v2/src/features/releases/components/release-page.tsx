"use client";

import {
  DetailLayout,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  FactsRail,
  StatusBadge,
  useUrlTab,
  QueryBoundary,
} from "@/design";
import { useRelease, useReleases } from "../hooks";
import { ReleaseBanner } from "./release-bits";
import { ChecksPane } from "./release-checks";
import { ReleaseFacts } from "./release-facts";
import { CriteriaPane, IssuesPane, NotesPane, OverviewPane, RELEASE_TABS, type ReleaseTab } from "./release-panes";

const LABEL: Record<ReleaseTab, string> = {
  overview: "Overview",
  issues: "Issues",
  criteria: "Criteria",
  checks: "Checks",
  notes: "Notes",
};

export function ReleasePage({ projectId, slug, version }: { projectId: string; slug: string; version: string }) {
  const [tab, onTab] = useUrlTab(RELEASE_TABS);
  const q = useRelease(projectId, version);
  const list = useReleases(projectId);
  return (
    <QueryBoundary query={q} loadingLabel="loading release…">
      {(data) => {
        const r = data.release;
        const tabs = [
          { value: "overview" as const, label: LABEL.overview },
          { value: "issues" as const, label: LABEL.issues, count: r.issues.length },
          { value: "criteria" as const, label: LABEL.criteria, count: r.criteria.total },
          { value: "checks" as const, label: LABEL.checks, count: r.attempts.length + r.approvals.length },
          { value: "notes" as const, label: LABEL.notes },
        ];
        return (
          <DetailLayout
            testId="release-detail"
            dataKey={r.key}
            rail={
              <FactsRail>
                <ReleaseFacts r={r} />
              </FactsRail>
            }
          >
            <DetailMobileTitle title={`Release ${r.version}`} badge={<StatusBadge family="releaseState" value={r.state} />} />
            <ReleaseBanner r={r} className="px-8 py-2.5 max-md:px-4" />
            <DetailTabs tabs={tabs} value={tab} onChange={onTab} testId="release-tabs" />
            {tab === "issues" ? (
              <IssuesPane r={r} slug={slug} />
            ) : (
              <DetailPane label={LABEL[tab]}>
                {tab === "overview" ? <OverviewPane r={r} slug={slug} all={list.data?.releases ?? [r]} /> : null}
                {tab === "criteria" ? <CriteriaPane r={r} /> : null}
                {tab === "checks" ? <ChecksPane r={r} /> : null}
                {tab === "notes" ? <NotesPane r={r} /> : null}
              </DetailPane>
            )}
          </DetailLayout>
        );
      }}
    </QueryBoundary>
  );
}
