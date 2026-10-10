"use client";

// The issue rail's trace rows (REQ-11 BC-3): the requirement revision the plan was made on when the
// requirement has moved since, the criteria it traces (an earlier wording's named stale), the workflow it builds or proposes, the feedback routed to it, the
// release that shipped it and the lease a run holds. Each is one short row, read from the issue and
// its standing; a row with nothing to say is left out.

import type { IssueStanding } from "@forge/contracts/issue-standing";
import Link from "next/link";
import { MonoTag, statusReading, ToneBadge } from "@/design";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { feedbackHref } from "@/lib/routes/feedback";
import { releaseHref } from "@/lib/routes/releases";
import { workflowHref } from "@/lib/routes/workflows";
import type { IssueDetail } from "../types";

/** One rail property: its label on the left, its value on the right. */
export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="fg-caption flex-none">{label}</span>
      <div className="min-w-0 text-right">{children}</div>
    </div>
  );
}

/** The workflow the issue builds, else the one it proposes a revision of. */
function WorkflowRow({ issue, slug }: { issue: Pick<IssueDetail, "buildsWorkflow" | "proposesWorkflow">; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const w = issue.buildsWorkflow ?? issue.proposesWorkflow;
  if (!w) return null;
  const proposes = !issue.buildsWorkflow && issue.proposesWorkflow ? issue.proposesWorkflow : null;
  return (
    <Row label={issue.buildsWorkflow ? t("issues.rail.builds") : t("issues.rail.proposes")}>
      <span className="grid justify-items-end gap-0.5" data-testid="rail-workflow">
        <Link href={workflowHref(slug, w.flow)} className="fg-body-sm text-link hover:underline">
          {w.title}
        </Link>
        <span className="text-12 text-muted">
          {proposes ? `r${proposes.revision} · ` : ""}
          {w.designStatus ? statusReading("design", w.designStatus, language).label : t("issues.rail.notDrawn")}
        </span>
      </span>
    </Row>
  );
}

export function RailTraceRows({
  issue,
  slug,
  standing,
}: {
  issue: Pick<IssueDetail, "buildsWorkflow" | "proposesWorkflow" | "shippedIn">;
  slug: string;
  standing: IssueStanding | undefined;
}) {
  const t = useCopy();
  const time = useTimeFormat();
  const req = standing?.requirement;
  return (
    <>
      {req && (req.criteria.length || req.staleCriteria.length) ? (
        <Row label={t("issues.rail.traces")}>
          <span className="fg-body-sm font-mono" data-testid="rail-traces">
            {req.criteria.join(", ")}
            {req.staleCriteria.length ? (
              <span className="ml-1.5 font-sans text-12 text-muted" data-testid="stale-traces">
                {t("issues.facts.staleShort", { codes: req.staleCriteria.join(", ") })}
              </span>
            ) : null}
          </span>
        </Row>
      ) : null}
      {req?.changedSincePlan ? (
        <Row label={t("issues.rail.planned")}>
          <span className="fg-body-sm text-amber-700 dark:text-amber-300" data-testid="changed-since-plan">
            {t("issues.facts.plannedOnShort", { planned: req.plannedRevision ?? "", now: req.currentRevision ?? "" })}
          </span>
        </Row>
      ) : null}
      <WorkflowRow issue={issue} slug={slug} />
      {standing?.feedback.length ? (
        <Row label={t("issues.facts.feedback")}>
          <span className="flex flex-wrap justify-end gap-x-2 gap-y-1" data-testid="rail-feedback">
            {standing.feedback.map((k) => (
              <span key={k} className="inline-flex items-baseline gap-1">
                <Link href={feedbackHref(slug, k)} className="font-mono text-12 font-semibold text-link hover:underline">
                  {k}
                </Link>
                {standing.feedbackDropped.includes(k) ? <span className="text-12 text-muted">{t("issues.facts.dropped")}</span> : null}
              </span>
            ))}
          </span>
        </Row>
      ) : null}
      {issue.shippedIn ? (
        <Row label={t("issues.rail.release")}>
          <span className="inline-flex items-baseline gap-2" data-testid="rail-release">
            <Link href={releaseHref(slug, issue.shippedIn.version)} className="font-mono text-12 font-semibold text-link hover:underline">
              {issue.shippedIn.version}
            </Link>
            <span className="text-12 text-muted">{time.date(issue.shippedIn.at)}</span>
          </span>
        </Row>
      ) : null}
      {standing?.lease ? (
        <Row label={t("issues.facts.lease")}>
          <span className="inline-flex min-w-0 flex-wrap items-center justify-end gap-1.5" data-testid="rail-lease">
            <ToneBadge
              tone={statusReading("lease", standing.lease.verdict).tone}
              label={t(`issues.lease.${standing.lease.verdict}`)}
              title={standing.lease.verdict}
              value={standing.lease.verdict}
            />
            {standing.lease.holder ? <MonoTag>{standing.lease.holder}</MonoTag> : null}
          </span>
        </Row>
      ) : null}
    </>
  );
}
