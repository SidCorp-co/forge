
import { RELEASE_PAGE_VIEWS, type ReleasePageViewKind } from "@forge/contracts/release-page";
import { DetailLayout, DetailMobileTitle, DetailPane, FactsRail, SegmentedControl, StatusBadge, useUrlChoice } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { useRelease, useReleasePage } from "../hooks";
import type { ReleaseDetail } from "../types";
import { ContinuedAs, EndedAttempt } from "./release-attempts";
import { ReleaseBanner, releaseTitle } from "./release-bits";
import { ReleaseMerges, ReleasePromotionBlock } from "./release-merges";
import { ReleasePageActions } from "./release-page-actions";
import { ReleaseRail } from "./release-rail";
import { ReleaseReader, useReleaseContents } from "./release-reader";
import { ReleaseRecord, recordContents } from "./release-record";

/**
 * The release as a reader reads it, in the view the person chose: the Technical view carries the
 * release's own record after the page, as sections of it and entries in its one contents.
 */
function ReaderPane({ projectId, r, slug, view }: { projectId: string; r: ReleaseDetail; slug: string; view: ReleasePageViewKind }) {
  const t = useCopy();
  const q = useReleasePage(projectId, r.version, view);
  const record = view === "developer" ? { contents: recordContents(r, t), node: <ReleaseRecord r={r} slug={slug} /> } : undefined;
  return (
    <DetailPane label={t("releases.page.loading")} testId="release-page-reader">
      <QueryBoundary query={q} loadingLabel={t("releases.page.loading")}>
        {(page) => <ReleaseReader page={page} slug={slug} authed railContents record={record} />}
      </QueryBoundary>
    </DetailPane>
  );
}

export function ReleasePage({ projectId, slug, version }: { projectId: string; slug: string; version: string }) {
  const t = useCopy();
  const [view, onView] = useUrlChoice<ReleasePageViewKind>("view", RELEASE_PAGE_VIEWS, "user");
  const q = useRelease(projectId, version);
  // the same read the reader pane holds: the share and export acts sit beside the view switch
  const pageQ = useReleasePage(projectId, version, view);
  const contents = useReleaseContents(pageQ.data, view === "developer" && q.data ? recordContents(q.data.release, t) : []);
  return (
    <QueryBoundary query={q} loadingLabel={t("releases.loadingOne")}>
      {(data) => {
        const r = data.release;
        return (
          <DetailLayout
            testId="release-detail"
            dataKey={r.key}
            rail={
              <FactsRail>
                <ReleaseRail r={r} page={pageQ.data} slug={slug} contents={contents} />
              </FactsRail>
            }
          >
            <DetailMobileTitle title={releaseTitle(r, t)} badge={<StatusBadge family="releaseState" value={r.state} />} />
            <ReleaseBanner r={r} className="px-8 py-2.5 max-md:px-4" />
            <EndedAttempt r={r} slug={slug} />
            <ReleasePromotionBlock promotion={r.promotion} slug={slug} />
            <ReleaseMerges issues={r.issues} slug={slug} />
            {r.continuedAs ? <ContinuedAs to={r.continuedAs} slug={slug} className="border-b border-line-subtle px-8 py-2 max-md:px-4" /> : null}
            <div className="flex flex-wrap items-center gap-3 border-b border-line-subtle px-8 py-2.5 max-md:px-4" data-testid="release-view-bar">
              <span data-tour="rel-technical" data-testid="release-view-switch" title={t("releases.page.view.label")}>
                <SegmentedControl
                  options={RELEASE_PAGE_VIEWS.map((v) => ({ value: v, label: t(`releases.page.view.${v}`) }))}
                  value={view}
                  onChange={onView}
                />
              </span>
              {pageQ.data ? (
                <span className="ml-auto">
                  <ReleasePageActions projectId={projectId} page={pageQ.data} />
                </span>
              ) : null}
            </div>
            <ReaderPane projectId={projectId} r={r} slug={slug} view={view} />
          </DetailLayout>
        );
      }}
    </QueryBoundary>
  );
}
