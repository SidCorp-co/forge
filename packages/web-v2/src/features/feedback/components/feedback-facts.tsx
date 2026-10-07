"use client";

// The at-a-glance facts of one feedback item: its phase and whose turn, what it is about, what carries
// it, and who sent it. The full page's sticky rail and the peek draw this one component, so the main
// column holds only what the reporter said, the acts, and the history.

import Link from "next/link";
import { ActorChip, EnumBadge, enumLabel, Fact, FactsEmpty, FactsGroup, StatusBadge, type StatusFamily, StepBar, WaitBanner, WaitingOn } from "@/design";
import { requirementHref } from "@/lib/routes/requirements";
import { issueHref } from "@/lib/routes/issues";
import { formatRelativeTime, formatStamp } from "@/lib/utils/format";
import { feedbackHref } from "@/lib/routes/feedback";
import type { FeedbackPhase, FeedbackRoute, FeedbackView } from "../types";
import { FEEDBACK_ATTENTION_LABELS, FEEDBACK_PHASE_LABELS } from "@forge/contracts/feedback";
import type { FeedbackShipNotice } from "@forge/contracts/feedback";
import type { FeedbackForecast } from "@forge/contracts/forecast";
import { EtaInline } from "@/features/forecast/components/eta-cell";
import { ReleaseLine } from "@/features/forecast/components/release-line";
import { type EtaClock, etaOfFeedback } from "@/features/forecast/eta";
import { ETA_COPY } from "@/features/forecast/eta-copy";
import { feedbackForecastText } from "@/features/forecast/text";
import { releaseHref } from "@/lib/routes/releases";

const STRIP: FeedbackPhase[] = ["new", "triaged", "planned", "resolved", "verified"];

/** New → Triaged → Planned → Resolved → Verified; a declined or reopened item reads off the strip. */
function PhaseSteps({ f }: { f: FeedbackView }) {
  const at = STRIP.indexOf(f.phase);
  if (at < 0) return null;
  return (
    <StepBar
      steps={STRIP.map((p, i) => ({
        key: p,
        label: FEEDBACK_PHASE_LABELS[p],
        state: i < at || (i === at && p === "verified") ? "done" : i === at ? "now" : "next",
        tone: f.attentionGroup === "needs_you" ? "you" : "run",
      }))}
    />
  );
}

/** The answer a question item was closed with, and who gave it: what the reporter is asked to confirm. */
function answerOf(f: FeedbackView): { text: string; by: string | null } | null {
  const text = f.route?.route === "answer" ? f.route.answer : null;
  if (!text) return null;
  const given = f.decisions.find((d) => d.route === "answer");
  return { text, by: given?.decidedByName ?? null };
}

/** One line at the top of the page and the peek: whom it waits on, from core's read model. */
export function FeedbackBanner({ f, slug, className }: { f: FeedbackView; slug?: string; className?: string }) {
  const w = f.waitingOn;
  const g = f.attentionGroup;
  const tone = FEEDBACK_ATTENTION_LABELS[g].tone;
  const version = f.route?.carriers.find((c) => c.release)?.release ?? null;
  const approving = g !== "done" && version !== null && w.ref === version && slug;
  const answer = g !== "done" && w.act === "Confirm the answer" ? answerOf(f) : null;
  return (
    <WaitBanner
      tone={g === "waiting" || g === "done" ? "calm" : tone}
      head={g === "done" ? `${FEEDBACK_PHASE_LABELS[f.phase]}.` : `Waiting on ${w.kind === "you" ? "you" : w.who}:`}
      body={
        g === "done" ? (
          "Nothing is owed on it."
        ) : approving ? (
          <>
            Approve release{" "}
            <Link className="font-mono text-12 font-semibold text-link hover:underline" href={releaseHref(slug as string, version as string)}>
              {version}
            </Link>
          </>
        ) : (
          w.act || w.who
        )
      }
      rule={w.rule}
      className={className}
    >
      {answer ? (
        <span data-testid="feedback-answer">
          {answer.by ? `${answer.by} answered: ` : "Answered: "}“{answer.text}”
        </span>
      ) : null}
    </WaitBanner>
  );
}

/** A key the reader can open, by what it names. */
function KeyLink({ type, k, slug }: { type: string; k: string; slug: string }) {
  const href = type === "requirement" ? requirementHref(slug, k) : type === "issue" ? issueHref(slug, k) : type === "feedback" ? feedbackHref(slug, k) : null;
  return href ? (
    <Link className="font-mono text-12 font-semibold text-link hover:underline" href={href}>
      {k}
    </Link>
  ) : (
    <span className="font-mono text-12">{k}</span>
  );
}

/** The carrier's own status, in its own vocabulary, read by what the route carries. */
const CARRIER_FAMILY = {
  issue: "issue",
  new_requirement: "requirement",
  duplicate: "feedbackPhase",
  revision: "suggestion",
  answer: null,
} as const satisfies Record<FeedbackRoute, StatusFamily | null>;

/** The item's line as its reporter means "done": who triages it, or when the fix is in people's hands. */
function ForecastFact({ forecast, slug, clock }: { forecast: FeedbackForecast | undefined; slug: string; clock?: EtaClock | undefined }) {
  const read = forecast ? feedbackForecastText(forecast) : null;
  if (!read) return null;
  const eta = clock ? etaOfFeedback(forecast, clock) : null;
  return (
    <>
      {eta ? (
        <Fact label={ETA_COPY[clock?.lang ?? "en"].header} testId="facts-feedback-eta">
          <EtaInline eta={eta} clock={clock as EtaClock} />
        </Fact>
      ) : null}
      <Fact label="Forecast" testId="facts-feedback-forecast">
        <ReleaseLine said={read} slug={slug} className="fg-body-sm text-muted" testId="feedback-forecast-line" />
      </Fact>
    </>
  );
}

/** Whether the release that shipped the work told the reporter, or why nobody was told. */
function ShipNoticeFact({ notice, slug }: { notice: FeedbackShipNotice | null | undefined; slug: string }) {
  if (!notice) return null;
  if (notice.state === "told") {
    return (
      <Fact label="Reporter told" testId="facts-ship-notice">
        <span className="fg-body-sm" title={formatStamp(notice.at)} data-testid="ship-notice-told">
          {formatRelativeTime(notice.at)}
          {notice.release ? (
            <>
              {" · "}
              <Link href={releaseHref(slug, notice.release)} className="font-mono text-link hover:underline">
                {notice.release}
              </Link>
            </>
          ) : null}
        </span>
      </Fact>
    );
  }
  return (
    <Fact label="Reporter told" testId="facts-ship-notice">
      <span className="fg-body-sm text-muted" data-testid="ship-notice-not-told">
        Not told · {notice.reason}
      </span>
    </Fact>
  );
}

export function FeedbackFacts({
  f,
  slug,
  forecast,
  clock,
}: {
  f: FeedbackView;
  slug: string;
  forecast?: FeedbackForecast | undefined;
  /** Language and clock of the ETA row; without one the row is left out. */
  clock?: EtaClock | undefined;
}) {
  const t = f.target;
  const r = f.route;
  const carrierType = r?.route === "issue" ? "issue" : r?.route === "new_requirement" ? "requirement" : r?.route === "duplicate" ? "feedback" : "other";
  return (
    <div data-testid="feedback-facts">
      <FactsGroup title="Status">
        <Fact label="State">
          <StatusBadge family="feedbackPhase" value={f.phase} />
        </Fact>
        {f.attentionGroup !== "done" ? (
          <Fact label="Waiting on">
            <WaitingOn w={f.waitingOn} />
          </Fact>
        ) : null}
        <ForecastFact forecast={forecast} slug={slug} clock={clock} />
        <ShipNoticeFact notice={f.shipNotice} slug={slug} />
        <Fact label="Severity">
          <StatusBadge family="severity" value={f.severity} />
        </Fact>
        <Fact label="Kind">
          <EnumBadge family="feedbackKind" value={f.kind} />
        </Fact>
        <div className="pt-2.5">
          <PhaseSteps f={f} />
        </div>
      </FactsGroup>

      <FactsGroup title="About" testId="facts-about">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-13">
          <EnumBadge family="feedbackTarget" value={t.type} />
          {t.type === "screen" ? <span>“{t.key}”</span> : <KeyLink type={t.type} k={t.key} slug={slug} />}
          {t.title ? <span className="min-w-0 truncate text-muted">{t.title}</span> : null}
        </div>
        {f.whereSeen && t.type !== "screen" ? <p className="mt-1.5 text-12-5 text-muted">Seen at {f.whereSeen}</p> : null}
      </FactsGroup>

      <FactsGroup title="Carried by" testId="facts-route">
        {!r ? (
          <FactsEmpty>Not routed yet.</FactsEmpty>
        ) : (
          <div className="grid gap-1.5 text-13">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <EnumBadge family="feedbackRoute" value={r.route} />
            </span>
            {r.carriers.length ? (
              <ul className="grid gap-1" data-testid="facts-route-carriers">
                {r.carriers.map((c, n) => (
                  <li key={c.key ?? n} className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="facts-route-carrier">
                    {c.key && carrierType !== "other" ? <KeyLink type={carrierType} k={c.key} slug={slug} /> : null}
                    {c.status && CARRIER_FAMILY[r.route] ? <StatusBadge family={CARRIER_FAMILY[r.route] as StatusFamily} value={c.status} /> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {r.answer ? <p className="whitespace-pre-wrap text-12-5 text-muted">{r.answer}</p> : null}
          </div>
        )}
        {f.duplicates.length > 0 ? (
          <Fact label="Duplicates">
            {f.duplicates.map((k) => (
              <KeyLink key={k} type="feedback" k={k} slug={slug} />
            ))}
          </Fact>
        ) : null}
      </FactsGroup>

      <FactsGroup title="Reporter">
        <Fact label="Sent by">
          <ActorChip name={f.reporter.name ?? "Unknown reporter"} kind={f.reporter.agency} />
        </Fact>
        <Fact label="Sent">
          <span title={formatStamp(f.createdAt)}>{formatRelativeTime(f.createdAt)}</span>
        </Fact>
        {f.source ? (
          <Fact label="From" testId="facts-source">
            <Link
              href={`/projects/${encodeURIComponent(slug)}/automation?tab=reports`}
              className="text-link hover:underline"
              title={`Agent report ${f.source.agentReport.id} · filed ${formatStamp(f.source.agentReport.createdAt)}`}
            >
              Agent report {f.source.agentReport.id.slice(0, 8)}
            </Link>
            <span className="text-12-5 text-muted">
              {enumLabel("agentReportKind", f.source.agentReport.kind)} · {enumLabel("agentReportTarget", f.source.agentReport.target)}
              {f.source.agentReport.targetRef ? ` ${f.source.agentReport.targetRef}` : ""}
            </span>
          </Fact>
        ) : null}
        {f.clarification ? (
          <Fact label="Clarification">
            <span className="grid gap-0.5" title={f.clarification.prompt ?? undefined}>
              <StatusBadge family="question" value={f.clarification.status} />
              {f.clarification.answer ? <span className="text-12-5 text-muted">{f.clarification.answer}</span> : null}
            </span>
          </Fact>
        ) : null}
        {f.sensitive ? (
          <Fact label="Data">
            <span className="text-12-5" title="This project's data policy scrubs feedback text on write; attachments are flagged">
              Sensitive · scrubbed on write
            </span>
          </Fact>
        ) : null}
      </FactsGroup>
    </div>
  );
}
