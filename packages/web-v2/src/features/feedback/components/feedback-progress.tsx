// One feedback item's progress, as its reader asks it (the owner's rule for feedback): is work on it
// running, which issues carry it and how far each has got, and when it is done. Every part is core's
// (`GET …/forecast/feedback/:fb`, `core forecast/feedback-progress.ts`) and this only says it. The
// Estimate row stands only where there is one, a date or the release that shipped it: why core gives
// no date is its own working, not the reader's, and the row is dropped rather than say it (ISS-903);
// the two that are state — snoozed until when, and fixed work waiting on a release cut — are the Work
// row's one status line.
// Whose turn it is stays the banner's, said once (REQ-43 BC-5).

import type { FeedbackProgress as Progress, FeedbackWork, FeedbackWorkState } from "@forge/contracts/forecast";
import { Link } from "@/lib/navigation/router";
import { type LegendTone, Property, PropertyList, Skeleton, StatusBadge, ToneBadge } from "@/design";
import { deliveryText, EtaInline, type EtaClock, etaOfFeedback, ReleaseLine, useFeedbackProgress } from "@/features/forecast";
import { formatApiError } from "@/lib/api/error";
import { useEtaClock } from "@/lib/i18n/eta-clock";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { feedbackHref } from "@/lib/routes/feedback";
import { issueHref } from "@/lib/routes/issues";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";

const STATE: Record<FeedbackWorkState, { key: ProductCopyKey; tone: LegendTone }> = {
  untriaged: { key: "feedback.progress.state.untriaged", tone: "you" },
  no_work: { key: "feedback.progress.state.idle", tone: "neutral" },
  no_issues: { key: "feedback.progress.state.unissued", tone: "neutral" },
  running: { key: "feedback.progress.state.running", tone: "run" },
  parked: { key: "feedback.progress.state.parked", tone: "blocked" },
  queued: { key: "feedback.progress.state.queued", tone: "neutral" },
  drafted: { key: "feedback.progress.state.drafted", tone: "neutral" },
  landed: { key: "feedback.progress.state.landed", tone: "ready" },
  shipped: { key: "feedback.progress.state.shipped", tone: "done" },
  ended: { key: "feedback.progress.state.ended", tone: "done" },
};

/** The work's state as one pill, pulsing while it runs, with how many issues are in progress. */
function WorkState({ work }: { work: FeedbackWork }) {
  const t = useCopy();
  const s = STATE[work.state];
  const label = t(s.key, { n: work.running, total: work.total });
  return <ToneBadge tone={s.tone} label={label} title={label} value={work.state} pulse={work.state === "running"} size="md" family="feedbackWork" />;
}

/**
 * The one status line beside the work's state, only where it applies (VISION: state-never-lies): a
 * snoozed item says until when, and fixed work no release carries yet says who cuts which release,
 * linked. Every other reason core gives for no date is its working, and draws nothing (ISS-903).
 */
function WorkLine({ p, slug, clock }: { p: Progress; slug: string; clock: EtaClock }) {
  const t = useCopy();
  const time = useTimeFormat();
  const e = p.estimate;
  if (e.kind !== "none") return null;
  if (e.reason === "snoozed" && e.until) {
    return (
      <span className="text-13 text-muted" data-testid="feedback-work-line" data-line="snoozed">
        {t("feedback.progress.snoozedUntil", { until: time.date(e.until) })}
      </span>
    );
  }
  if (e.reason === "release_waits" && p.forecast.delivery) {
    return <ReleaseLine said={deliveryText(p.forecast.delivery, clock)} slug={slug} className="text-13 text-muted" testId="feedback-work-line" />;
  }
  return null;
}

/** What carries the work: the requirement it opened or the original it duplicates, then each issue with its status. */
function Carriers({ work, slug }: { work: FeedbackWork; slug: string }) {
  const t = useCopy();
  if (!work.requirement && !work.duplicateOf && work.issues.length === 0) return null;
  return (
    <Property label={t("feedback.progress.carriedBy")} testId="feedback-progress-carriers">
      <span className="grid min-w-0 gap-1">
        {work.duplicateOf ? (
          <span className="text-13 text-muted">
            {t("feedback.progress.follows")}{" "}
            <Link href={feedbackHref(slug, work.duplicateOf)} className="font-mono text-12 font-semibold text-link hover:underline">
              {work.duplicateOf}
            </Link>
          </span>
        ) : null}
        {work.requirement ? (
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Link href={requirementHref(slug, work.requirement.key)} className="font-mono text-12 font-semibold text-link hover:underline">
              {work.requirement.key}
            </Link>
            <StatusBadge family="requirement" value={work.requirement.status} />
            <span className="min-w-0 truncate text-13 text-muted">{work.requirement.title}</span>
          </span>
        ) : null}
        {work.issues.length > 0 ? (
          <ul className="grid gap-1" data-testid="feedback-progress-issues">
            {work.issues.map((i) => (
              <li key={i.key} className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="feedback-progress-issue" data-status={i.status}>
                <Link href={issueHref(slug, i.key)} className="font-mono text-12 font-semibold text-link hover:underline">
                  {i.key}
                </Link>
                <StatusBadge family="issue" value={i.status} />
                <span className="min-w-0 truncate text-13 text-muted">{i.title}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </span>
    </Property>
  );
}

/** Whether the item has an estimate to show: a date core forecast, or the release that shipped it. */
function hasEstimate(p: Progress, clock: EtaClock): boolean {
  return p.estimate.kind === "shipped" || (p.estimate.kind === "dated" && etaOfFeedback(p.forecast, clock) !== null);
}

function Estimate({ p, slug, clock }: { p: Progress; slug: string; clock: EtaClock }) {
  const t = useCopy();
  const time = useTimeFormat();
  const e = p.estimate;
  if (e.kind === "dated") {
    const eta = etaOfFeedback(p.forecast, clock);
    return eta ? <EtaInline eta={eta} clock={clock} /> : null;
  }
  if (e.kind === "shipped") {
    return (
      <span className="fg-body-sm" data-testid="feedback-progress-shipped">
        {e.version ? (
          <>
            {t("feedback.progress.shippedIn")}{" "}
            <Link href={releaseHref(slug, e.version)} className="font-mono text-link hover:underline">
              {e.version}
            </Link>
          </>
        ) : (
          t("feedback.progress.state.shipped")
        )}
        {e.at ? <span className="text-muted"> · {time.date(e.at)}</span> : null}
      </span>
    );
  }
  return null;
}

/** The item's progress block: work, what carries it, and its estimate where it has one. */
export function FeedbackProgress({ projectId, slug, fbKey, className }: { projectId: string; slug: string; fbKey: string; className?: string }) {
  const t = useCopy();
  const clock = useEtaClock();
  const q = useFeedbackProgress(projectId, fbKey);
  return (
    <section aria-label={t("feedback.progress.title")} className={className} data-testid="feedback-progress" data-work={q.data?.work.state} data-estimate={q.data ? (q.data.estimate.kind === "none" ? q.data.estimate.reason : q.data.estimate.kind) : undefined}>
      {q.isPending ? (
        <Skeleton className="h-16 w-full max-w-xl" />
      ) : q.isError ? (
        <p className="text-13 text-danger" role="alert" data-testid="feedback-progress-unread">
          {t("feedback.progress.unread", { why: formatApiError(q.error) })}
        </p>
      ) : (
        <PropertyList>
          <Property label={t("feedback.progress.work")} testId="feedback-progress-work">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <WorkState work={q.data.work} />
              <WorkLine p={q.data} slug={slug} clock={clock} />
            </span>
          </Property>
          <Carriers work={q.data.work} slug={slug} />
          {hasEstimate(q.data, clock) ? (
            <Property label={t("feedback.progress.estimate")} testId="feedback-progress-estimate">
              <Estimate p={q.data} slug={slug} clock={clock} />
            </Property>
          ) : null}
        </PropertyList>
      )}
    </section>
  );
}
