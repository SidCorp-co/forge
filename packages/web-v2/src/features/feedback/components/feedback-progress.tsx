// One feedback item's progress, as its reader asks it (the owner's rule for feedback): is work on it
// running, which issues carry it and how far each has got, and when it is done, or plainly why no
// date can be given. Every part is core's (`GET …/forecast/feedback/:fb`, `core
// forecast/feedback-progress.ts`): the state, the issues and the estimate's reason are decided there,
// and this only says them. Whose turn it is stays the banner's, said once (REQ-43 BC-5).

import type { FeedbackEstimate, FeedbackProgress as Progress, FeedbackWork, FeedbackWorkState } from "@forge/contracts/forecast";
import { Link } from "@/lib/navigation/router";
import { type LegendTone, Property, PropertyList, Skeleton, StatusBadge, ToneBadge } from "@/design";
import { EtaInline, type EtaClock, etaOfFeedback, feedbackForecastText, ReleaseLine, useFeedbackProgress } from "@/features/forecast";
import { formatApiError } from "@/lib/api/error";
import { useEtaClock } from "@/lib/i18n/eta-clock";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { said } from "@/lib/i18n/said";
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

const WHY: Record<Extract<FeedbackEstimate, { kind: "none" }>["reason"], ProductCopyKey> = {
  untriaged: "feedback.progress.why.untriaged",
  snoozed: "feedback.progress.why.snoozed",
  no_work: "feedback.progress.why.answered",
  no_issues: "feedback.progress.why.unissued",
  waits: "feedback.progress.why.waits",
  history: "feedback.progress.why.history",
  ended: "feedback.progress.why.ended",
  release_waits: "feedback.progress.why.releaseWaits",
  release_history: "feedback.progress.why.releaseHistory",
};

/** The work's state as one pill, pulsing while it runs, with how many issues are in progress. */
function WorkState({ work }: { work: FeedbackWork }) {
  const t = useCopy();
  const s = STATE[work.state];
  const label = t(s.key, { n: work.running, total: work.total });
  return <ToneBadge tone={s.tone} label={label} title={label} value={work.state} pulse={work.state === "running"} size="md" family="feedbackWork" />;
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

/** The reasons a wait holds the date: the forecast's own line names who owes the act, and the release it cuts. */
const NAMES_WHO: readonly string[] = ["untriaged", "waits", "release_waits"];

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
  const who = e.waits ? said(e.waits.who, clock.lang) : "";
  const line = t(WHY[e.reason], { who, n: e.history?.n ?? 0, floor: e.history?.floor ?? 0, until: e.until ? time.date(e.until) : "" });
  const next = NAMES_WHO.includes(e.reason) ? feedbackForecastText(p.forecast, clock) : null;
  return (
    <span className="grid gap-0.5" data-testid="feedback-progress-no-date" data-reason={e.reason}>
      <span className="fg-body-sm text-fg">{line}</span>
      {next ? <ReleaseLine said={next} slug={slug} className="text-13 text-muted" testId="feedback-forecast-line" /> : null}
    </span>
  );
}

/** The item's progress block: work, what carries it, and its estimate or why it has none. */
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
            <WorkState work={q.data.work} />
          </Property>
          <Carriers work={q.data.work} slug={slug} />
          <Property label={t("feedback.progress.estimate")} testId="feedback-progress-estimate">
            <Estimate p={q.data} slug={slug} clock={clock} />
          </Property>
        </PropertyList>
      )}
    </section>
  );
}
