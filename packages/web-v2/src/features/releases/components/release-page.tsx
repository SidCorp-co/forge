// A release page in the approved report shape (ISS-1001): where it stands on its own lifecycle drawn
// as a step track, its one proof number, what users see by screen, what needs the decider's
// attention, and everything technical — change requests, the promotion branch, commits, the roster and
// the release's own record — behind one "Technical" line that opens a side drawer, never in place
// (REQ-43 r3 BC-17). The one act it waits on sits once, in the header (`release-item-screen.tsx`).

import { RELEASE_CHANGE_GROUPS, releaseGlanceOf } from "@forge/contracts/release-digest";
import type { ReleaseState } from "@forge/contracts/releases";
import { useState } from "react";
import { Property, PropertyList, SlideOver, StepBar, statusReading } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
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
import { ReleaseSites } from "./release-sites";
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

/**
 * Where the release stands, behind Technical: its status, who approved it and who may (REQ-70 BC-1,
 * the page read's approvers, by name), and where it goes (REQ-71 BC-6: a release its owner deploys
 * ends at merge).
 */
export function WhereItStands({ r, approvers }: { r: ReleaseDetail; approvers?: readonly { name: string }[] | undefined }) {
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
      {approvers && approvers.length > 0 ? (
        <Property label={t("releases.standing.label.approvers")} testId="standing-approvers">
          {approvers.map((a) => a.name).join(", ")}
        </Property>
      ) : null}
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

/**
 * Draft → (awaiting approval) → going out → shipped, or landed where the release ends at merge, as a
 * bar naming no state (the header's badge names it); a returned, failed or aborted release reads off
 * the track and draws none.
 */
export function ReleaseSteps({ r }: { r: ReleaseDetail }) {
  const language = useInterfaceLanguage();
  const track: ReleaseState[] = ["draft", ...(r.approvalRequired ? (["awaiting_approval"] as const) : []), "in_progress", r.state === "landed" ? "landed" : "shipped"];
  const at = track.indexOf(r.state);
  if (at < 0) return null;
  const last = track.length - 1;
  return (
    <div data-testid="release-steps">
      <StepBar
        named={false}
        steps={track.map((s, i) => {
          const reading = statusReading("releaseState", s, language);
          return { key: s, label: reading.label, tone: reading.tone, state: i < at || (i === at && i === last) ? "done" : i === at ? "now" : "next" };
        })}
      />
    </div>
  );
}

function TechnicalFold({ projectId, r, slug }: { projectId: string; r: ReleaseDetail; slug: string }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  // the same read the page body draws, so a cached one: who may approve is the page header's (ISS-1164)
  const approvers = useReleasePage(projectId, r.version, "user").data?.header.approvers;
  const requests = changeRequestItems(r.issues).length;
  const said = [
    t("releases.technical.title"),
    ...(r.issueCount > 0 ? [t("releases.issuesCount", { n: r.issueCount })] : []),
    ...(requests > 0 ? [t("releases.technical.requests", { n: requests })] : []),
    ...(r.promotion ? [t("releases.technical.promotion")] : []),
  ];
  return (
    <div className="border-t border-line-subtle" data-testid="release-technical-fold">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="py-3 text-left text-13 text-muted hover:text-fg"
        data-testid="release-technical-summary"
        data-tour="rel-technical"
      >
        {said.join(" · ")}
      </button>
      <SlideOver open={open} onClose={() => setOpen(false)} title={t("releases.technical.title")} width={760}>
        {/* the developer view is read only once the drawer is opened */}
        {open ? (
          <div className="grid gap-6 pb-6" data-testid="release-technical-body">
            <WhereItStands r={r} approvers={approvers} />
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
      </SlideOver>
    </div>
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
              <ReleaseSteps r={r} />
              <ReleaseProofBar proof={releaseProofOf(r.verified)} />
              <NextStep r={r} />
              <ReleaseSites r={r} />
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
