// A release page in the approved report shape (ISS-1001): its one proof number, what users see by
// screen, what needs the decider's attention, and everything technical — change requests, the
// promotion branch, commits, the roster and the release's own record — behind one collapsed
// "Technical" section. The one act it waits on sits once, in the header (`release-item-screen.tsx`).

import { RELEASE_CHANGE_GROUPS, releaseGlanceOf } from "@forge/contracts/release-digest";
import { useState } from "react";
import { Property, PropertyList } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useRelease, useReleasePage } from "../hooks";
import { releaseProofOf } from "../proof";
import { releaseStandingOf } from "../release-standing";
import type { ReleaseDetail } from "../types";
import { ContinuedAs, EndedAttempt } from "./release-attempts";
import { ShippedFailingBanner, shortSha } from "./release-bits";
import { changeRequestItems, ReleaseMerges, ReleasePromotionBlock } from "./release-merges";
import { ReleasePageActions } from "./release-page-actions";
import { ReleaseProofBar } from "./release-proof";
import { ReleaseRecord, ReleaseTagLine } from "./release-record";
import { ReleaseReport } from "./release-report";
import { ChangeGroup, OtherChanges, Requirements, StillOpen } from "./release-groups";
import { checksByIssue } from "./release-row-detail";
import { ReleaseStalls } from "./release-stalls";
import { Technical } from "./release-technical";

/**
 * The developer view, read only once the Technical section is opened: the roster, each change under
 * its group with the criteria that prove it, each requirement it moves, what is still open, then the
 * stalls and the technical notes.
 */
function DeveloperNotes({ projectId, version, slug }: { projectId: string; version: string; slug: string }) {
  const t = useCopy();
  const q = useReleasePage(projectId, version, "developer");
  return (
    <QueryBoundary query={q} loadingLabel={t("releases.page.loading")}>
      {(page) => {
        const glance = releaseGlanceOf(page);
        const checks = checksByIssue(page);
        const reach = { slug, authed: true };
        return (
          <div className="grid gap-6" data-testid="release-roster">
            {RELEASE_CHANGE_GROUPS.map((g) => (
              <ChangeGroup key={g} group={g} rows={glance.groups[g]} page={page} checks={checks} reach={reach} />
            ))}
            <Requirements page={page} slug={slug} />
            <StillOpen page={page} reach={reach} />
            <OtherChanges page={page} reach={reach} />
            <ReleaseStalls page={page} />
            <Technical page={page} slug={slug} />
          </div>
        );
      }}
    </QueryBoundary>
  );
}

/** Where the release stands, behind Technical: its status, who approves it, and where it goes (REQ-71 BC-6: a release its owner deploys ends at merge). */
export function WhereItStands({ r }: { r: ReleaseDetail }) {
  const t = useCopy();
  const time = useTimeFormat();
  const s = releaseStandingOf(r, t, time.date);
  return (
    <PropertyList testId="release-standing">
      <Property label={t("releases.standing.label.status")} testId="standing-status">
        {s.status}
      </Property>
      <Property label={t("releases.standing.label.approver")} testId="standing-approver">
        {s.approver}
      </Property>
      <Property label={t("releases.standing.label.goesTo")} testId="standing-goes-to">
        {s.goesTo}
      </Property>
    </PropertyList>
  );
}

/**
 * The next step, said once at the top where the reader has no act of their own to take on it
 * (judged on the testing environment first, a production environment to name, the agent merging):
 * where the reader has one, the header's act is that step and this says nothing.
 */
function NextStep({ r }: { r: ReleaseDetail }) {
  const t = useCopy();
  const time = useTimeFormat();
  if (r.can.cut || r.can.decide || r.can.split) return null;
  const next = releaseStandingOf(r, t, time.date).next;
  if (!next) return null;
  return (
    <p className="text-13 font-medium text-warn-11" data-testid="standing-next">
      {t("releases.peek.next", { step: next })}
    </p>
  );
}

function TechnicalFold({ projectId, r, slug }: { projectId: string; r: ReleaseDetail; slug: string }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const requests = changeRequestItems(r.issues).length;
  const said = [
    t("releases.technical.title"),
    ...(requests > 0 ? [t("releases.technical.requests", { n: requests })] : []),
    ...(r.promotion ? [t("releases.technical.promotion")] : []),
  ];
  return (
    <details className="border-t border-line-subtle" data-testid="release-technical-fold" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer py-3 text-13 text-muted hover:text-fg" data-testid="release-technical-summary">
        {said.join(" · ")}
      </summary>
      {open ? (
        <div className="grid gap-6 pb-6" data-testid="release-technical-body">
          <WhereItStands r={r} />
          {r.head ? <p className="font-mono text-12 text-muted">{t("releases.technical.build", { sha: shortSha(r.head) })}</p> : null}
          <ReleaseTagLine r={r} />
          <ShippedFailingBanner r={r} />
          <EndedAttempt r={r} slug={slug} />
          <ReleasePromotionBlock promotion={r.promotion} slug={slug} />
          <ReleaseMerges issues={r.issues} slug={slug} />
          <ReleaseRecord r={r} slug={slug} />
          <DeveloperNotes projectId={projectId} version={r.version} slug={slug} />
        </div>
      ) : null}
    </details>
  );
}

export function ReleasePage({ projectId, slug, version }: { projectId: string; slug: string; version: string }) {
  const t = useCopy();
  const q = useRelease(projectId, version);
  const pageQ = useReleasePage(projectId, version, "user");
  return (
    <QueryBoundary query={q} loadingLabel={t("releases.loadingOne")}>
      {(data) => {
        const r = data.release;
        return (
          <div className="grid max-w-4xl gap-6 px-8 py-5 max-md:px-4" data-testid="release-detail" data-key={r.key}>
            <div className="grid gap-2">
              <ReleaseProofBar proof={releaseProofOf(r.verified)} issues={r.issueCount} />
              <NextStep r={r} />
              {r.continuedAs ? <ContinuedAs to={r.continuedAs} slug={slug} /> : null}
            </div>
            <QueryBoundary query={pageQ} loadingLabel={t("releases.page.loading")}>
              {(page) => <ReleaseReport page={page} />}
            </QueryBoundary>
            <TechnicalFold projectId={projectId} r={r} slug={slug} />
            {pageQ.data ? <ReleasePageActions projectId={projectId} page={pageQ.data} /> : null}
          </div>
        );
      }}
    </QueryBoundary>
  );
}
