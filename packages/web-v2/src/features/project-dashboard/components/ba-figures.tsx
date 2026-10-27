
// The Dashboard's pictures for a BA or PM, side by side: requirements by state with how many of their
// criteria are proven, open feedback by where it stands, and the next release's issues by how far
// each has got. Each is a stacked bar over its whole with a legend of counts, and its title links to
// the list it draws. Delivery's health over a window is `health-panel.tsx`, below them.

import type { IssueProgress } from "@forge/contracts/forecast";
import { REQUIREMENT_STATE_TONES } from "@forge/contracts/requirements";
import type { ReactNode } from "react";
import { BulletBar, CoverageBar, type CoverageSegment } from "@/design";
import { Link } from "@/lib/navigation/router";
import { feedbackListHref } from "@/lib/routes/feedback";
import { releaseHref, releasesListHref } from "@/lib/routes/releases";
import { requirementsHref } from "@/lib/routes/requirements";
import type { FeedbackFigures, requirementsByState } from "../ba-derive";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";

function Picture({ title, href, figure, children, testId }: { title: string; href: string; figure?: ReactNode; children: ReactNode; testId: string }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-1 flex-col gap-3" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-2">
        <Link href={href} className="text-13 font-semibold text-fg underline-offset-2 hover:underline">
          {title}
        </Link>
        {figure ? <span className="font-mono text-13 font-semibold tabular-nums text-muted">{figure}</span> : null}
      </div>
      {children}
    </section>
  );
}

const Nothing = ({ children }: { children: ReactNode }) => <p className="text-13 text-subtle">{children}</p>;

interface BaFiguresProps {
  slug: string;
  requirements: ReturnType<typeof requirementsByState>;
  /** Criteria proven across the requirements on the delivery line; null while it is read. */
  criteria: { proven: number; total: number } | null;
  feedback: FeedbackFigures;
  /** The release nearest people's hands and its issues' progress; null where none is on its way. */
  release: { version: string; progress: IssueProgress } | null;
}

export function BaFigures({ slug, requirements, criteria, feedback, release }: BaFiguresProps) {
  const t = useCopy();
  const label = useLabel();
  const reqTotal = requirements.reduce((n, r) => n + r.count, 0);
  const reqSegments: CoverageSegment[] = requirements.map((r) => ({ key: r.state, label: label("requirementState", r.state), count: r.count, tone: REQUIREMENT_STATE_TONES[r.state] }));
  const fbSegments: CoverageSegment[] = [
    { key: "stuck", label: t("dash.fbStuck"), count: feedback.stuck, tone: "err" },
    { key: "untriaged", label: t("dash.fbUntriaged"), count: feedback.open - feedback.stuck - feedback.moving, tone: "you" },
    { key: "moving", label: t("dash.fbMoving"), count: feedback.moving, tone: "run" },
  ];
  const relSegments: CoverageSegment[] = release
    ? [
        { key: "shipped", label: t("dash.rel.shipped"), count: release.progress.shipped, tone: "ready" },
        { key: "awaiting", label: t("dash.rel.awaiting"), count: release.progress.awaitingRelease, tone: "run" },
        { key: "toDo", label: t("dash.rel.toDo"), count: release.progress.toDo, tone: "neutral" },
      ]
    : [];
  return (
    <div aria-label={t("dash.progress")} role="group" data-testid="ba-figures" className="grid gap-x-10 gap-y-6 border-b border-line-subtle pb-6 md:flex">
      <Picture title={t("dash.requirements")} href={`${requirementsHref(slug)}?group=status`} figure={reqTotal} testId="pic-requirements">
        {reqTotal === 0 ? <Nothing>{t("dash.noRequirements")}</Nothing> : <CoverageBar segments={reqSegments} />}
        {criteria && criteria.total > 0 ? <BulletBar label={t("dash.criteriaProven")} value={criteria.proven} total={criteria.total} color="var(--green-500)" /> : null}
      </Picture>
      <Picture title={t("dash.feedback")} href={feedbackListHref(slug)} figure={feedback.open} testId="pic-feedback">
        {feedback.open === 0 ? <Nothing>{t("dash.noFeedback")}</Nothing> : <CoverageBar segments={fbSegments} />}
      </Picture>
      <Picture
        title={release ? `${t("dash.nextRelease")} ${release.version}` : t("dash.nextRelease")}
        href={release ? releaseHref(slug, release.version) : releasesListHref(slug)}
        figure={release?.progress.total}
        testId="pic-release"
      >
        {release && release.progress.total > 0 ? <CoverageBar segments={relSegments} /> : <Nothing>{t("dash.nothingInPreparation")}</Nothing>}
      </Picture>
    </div>
  );
}
