"use client";

// The at-a-glance facts of one feedback item: its phase and whose turn, what it is about, what carries
// it, and who sent it. The full page's sticky rail and the peek draw this one component, so the main
// column holds only what the reporter said, the acts, and the history.

import Link from "next/link";
import { ActorChip, EnumBadge, enumLabel, Fact, FactsEmpty, FactsGroup, StatusBadge, type StatusFamily, StepBar, WaitBanner, WaitingOn } from "@/design";
import { requirementHref } from "@/lib/routes/requirements";
import { issueHref } from "@/lib/routes/issues";
import { useCopy, useInterfaceLanguage, useLabel, useTimeFormat } from "@/lib/i18n/interface-language";
import { said, saysKey } from "@/lib/i18n/said";
import { feedbackHref } from "@/lib/routes/feedback";
import type { FeedbackPhase, FeedbackRoute, FeedbackView } from "../types";
import { FEEDBACK_ATTENTION_LABELS } from "@forge/contracts/feedback";
import type { FeedbackShipNotice } from "@forge/contracts/feedback";
import type { FeedbackForecast } from "@forge/contracts/forecast";
import { EtaInline } from "@/features/forecast/components/eta-cell";
import { ReleaseLine } from "@/features/forecast/components/release-line";
import { type EtaClock, etaOfFeedback } from "@/features/forecast/eta";
import { ETA_COPY } from "@/features/forecast/eta-copy";
import { feedbackForecastText } from "@/features/forecast/text";
import { releaseHref } from "@/lib/routes/releases";
import { useEtaClock } from "@/features/forecast/hooks";

const STRIP: FeedbackPhase[] = ["new", "triaged", "planned", "resolved", "verified"];

/** New → Triaged → Planned → Resolved → Verified; a declined or reopened item reads off the strip. */
function PhaseSteps({ f }: { f: FeedbackView }) {
  const label = useLabel();
  const at = STRIP.indexOf(f.phase);
  if (at < 0) return null;
  return (
    <StepBar
      steps={STRIP.map((p, i) => ({
        key: p,
        label: label("feedbackPhase", p),
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
  const t = useCopy();
  const label = useLabel();
  const language = useInterfaceLanguage();
  const w = f.waitingOn;
  const g = f.attentionGroup;
  const tone = FEEDBACK_ATTENTION_LABELS[g].tone;
  const version = f.route?.carriers.find((c) => c.release)?.release ?? null;
  const approving = g !== "done" && version !== null && w.ref === version && slug && saysKey(w.says.act, "standing.act.approveReleaseV");
  const verifying = g !== "done" && version !== null && w.ref === version && slug && saysKey(w.says.act, "standing.act.verifyFixIn");
  const answer = g !== "done" && saysKey(w.says.act, "standing.act.confirmAnswer") ? answerOf(f) : null;
  return (
    <WaitBanner
      tone={g === "waiting" || g === "done" ? "calm" : tone}
      head={g === "done" ? `${label("feedbackPhase", f.phase)}.` : t("feedback.banner.waitingOn", { who: w.kind === "you" ? t("feedback.banner.you") : said(w.says.who, language) })}
      body={
        g === "done" ? (
          t("feedback.banner.nothingOwed")
        ) : approving ? (
          <>
            {t("feedback.banner.approveRelease")}{" "}
            <Link className="font-mono text-12 font-semibold text-link hover:underline" href={releaseHref(slug as string, version as string)}>
              {version}
            </Link>
          </>
        ) : verifying ? (
          <>
            {t("feedback.banner.verifyShippedIn")}{" "}
            <Link className="font-mono text-12 font-semibold text-link hover:underline" href={releaseHref(slug as string, version as string)}>
              {version}
            </Link>
          </>
        ) : (
          said(w.says.act, language) || said(w.says.who, language)
        )
      }
      rule={said(w.says.rule, language)}
      className={className}
    >
      {answer ? (
        <span data-testid="feedback-answer">
          {answer.by ? t("feedback.banner.answeredBy", { by: answer.by }) : t("feedback.banner.answered")}“{answer.text}”
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
  const t = useCopy();
  const fallbackClock = useEtaClock();
  const read = forecast ? feedbackForecastText(forecast, clock ?? fallbackClock) : null;
  if (!read) return null;
  const eta = clock ? etaOfFeedback(forecast, clock) : null;
  return (
    <>
      {eta ? (
        <Fact label={ETA_COPY[clock?.lang ?? "en"].header} testId="facts-feedback-eta">
          <EtaInline eta={eta} clock={clock as EtaClock} />
        </Fact>
      ) : null}
      <Fact label={t("feedback.fact.forecast")} testId="facts-feedback-forecast">
        <ReleaseLine said={read} slug={slug} className="fg-body-sm text-muted" testId="feedback-forecast-line" />
      </Fact>
    </>
  );
}

/** When and in which release the work shipped, ahead of why the reporter was not told: the ship is the fact, the silence its consequence. */
function ShippedLine({ notice, slug }: { notice: Extract<FeedbackShipNotice, { state: "not_told" }>; slug: string }) {
  const t = useCopy();
  const time = useTimeFormat();
  const { at, release } = notice.shipped;
  if (!at && !release) return null;
  return (
    <>
      {t("feedback.fact.shipped")}
      {release ? (
        <>
          {t("feedback.fact.shippedIn")}
          <Link href={releaseHref(slug, release)} className="font-mono text-link hover:underline">
            {release}
          </Link>
        </>
      ) : null}
      {at ? t("feedback.fact.shippedOn", { date: time.dateTime(at) }) : null}
      {". "}
    </>
  );
}

/** Whether the release that shipped the work told the reporter, or why nobody was told. */
function ShipNoticeFact({ notice, slug }: { notice: FeedbackShipNotice | null | undefined; slug: string }) {
  const t = useCopy();
  const time = useTimeFormat();
  const language = useInterfaceLanguage();
  if (!notice) return null;
  if (notice.state === "told") {
    return (
      <Fact label={t("feedback.fact.reporterTold")} testId="facts-ship-notice">
        <span className="fg-body-sm" title={time.dateTime(notice.at)} data-testid="ship-notice-told">
          {time.relative(notice.at)}
          {notice.release ? (
            <>
              {" · "}
              <Link href={releaseHref(slug, notice.release)} className="font-mono text-link hover:underline">
                {notice.release}
              </Link>
            </>
          ) : null}
          {notice.says.told ? (
            <span className="block text-12-5 text-muted" data-testid="ship-notice-how">
              {said(notice.says.told, language)}
            </span>
          ) : null}
        </span>
      </Fact>
    );
  }
  return (
    <Fact label={t("feedback.fact.reporterTold")} testId="facts-ship-notice">
      <span className="fg-body-sm text-muted" data-testid="ship-notice-not-told">
        <ShippedLine notice={notice} slug={slug} />
        {notice.beforeNotices ? <span data-testid="ship-notice-before">{said(notice.says.reason, language)}</span> : said(notice.says.reason, language)}
      </span>
    </Fact>
  );
}

/** Who confirmed the fix and when, or the day Forge will if nobody does: the record behind "Reporter told". */
function VerifiedFact({ f }: { f: FeedbackView }) {
  const t = useCopy();
  const time = useTimeFormat();
  const language = useInterfaceLanguage();
  if (f.verified) {
    const v = f.verified;
    return (
      <Fact label={t("feedback.fact.verified")} testId="facts-verified">
        <span className="fg-body-sm" title={time.dateTime(v.at)} data-testid="verified-line">
          {v.how === "automatic"
            ? t("feedback.fact.verifiedAuto")
            : t("feedback.fact.verifiedBy", { who: v.byReporter ? t("feedback.fact.theReporter") : (v.byName ?? t("feedback.fact.aMember")) })}
          {" · "}
          {time.relative(v.at)}
          {v.how === "automatic" && v.says.reason ? <span className="block text-12-5 text-muted">{said(v.says.reason, language)}</span> : null}
        </span>
      </Fact>
    );
  }
  if (!f.autoVerify) return null;
  return (
    <Fact label={t("feedback.fact.verifiesItself")} testId="facts-auto-verify">
      <span className="fg-body-sm text-muted" title={time.dateTime(f.autoVerify.at)}>
        {t("feedback.fact.verifiesAt", { at: time.dateTime(f.autoVerify.at), n: f.autoVerify.windowDays })}
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
  const tr = useCopy();
  const time = useTimeFormat();
  const language = useInterfaceLanguage();
  const t = f.target;
  const r = f.route;
  const carrierType = r?.route === "issue" ? "issue" : r?.route === "new_requirement" ? "requirement" : r?.route === "duplicate" ? "feedback" : "other";
  return (
    <div data-testid="feedback-facts">
      <FactsGroup title={tr("feedback.fact.status")}>
        <Fact label={tr("feedback.fact.state")}>
          <StatusBadge family="feedbackPhase" value={f.phase} />
        </Fact>
        {f.attentionGroup !== "done" ? (
          <Fact label={tr("feedback.fact.waitingOn")}>
            <WaitingOn w={f.waitingOn} />
          </Fact>
        ) : null}
        <ForecastFact forecast={forecast} slug={slug} clock={clock} />
        <ShipNoticeFact notice={f.shipNotice} slug={slug} />
        <VerifiedFact f={f} />
        {f.snoozed ? (
          <Fact label={tr("feedback.fact.snoozed")} testId="facts-snoozed">
            <span className="fg-body-sm" data-testid="snoozed-until">
              {tr("feedback.row.snoozedUntil", { date: time.dateTime(f.snoozed.until) })}
              {f.snoozed.reason ? <span className="block text-12-5 text-muted">{f.snoozed.reason}</span> : null}
            </span>
          </Fact>
        ) : null}
        <Fact label={tr("feedback.fact.severity")}>
          <StatusBadge family="severity" value={f.severity} />
        </Fact>
        <Fact label={tr("feedback.fact.kind")}>
          <EnumBadge family="feedbackKind" value={f.kind} />
        </Fact>
        <div className="pt-2.5">
          <PhaseSteps f={f} />
        </div>
      </FactsGroup>

      <FactsGroup title={tr("feedback.fact.about")} testId="facts-about">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-13">
          <EnumBadge family="feedbackTarget" value={t.type} />
          {t.type === "screen" ? <span>“{t.key}”</span> : <KeyLink type={t.type} k={t.key} slug={slug} />}
          {t.title ? <span className="min-w-0 truncate text-muted">{t.title}</span> : null}
        </div>
        {f.whereSeen && t.type !== "screen" ? <p className="mt-1.5 text-12-5 text-muted">{tr("feedback.fact.seenAt", { where: f.whereSeen })}</p> : null}
      </FactsGroup>

      <FactsGroup title={tr("feedback.fact.carriedBy")} testId="facts-route">
        {!r ? (
          <FactsEmpty>{tr("feedback.fact.notRouted")}</FactsEmpty>
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
          <Fact label={tr("feedback.fact.duplicates")}>
            {f.duplicates.map((k) => (
              <KeyLink key={k} type="feedback" k={k} slug={slug} />
            ))}
          </Fact>
        ) : null}
      </FactsGroup>

      <FactsGroup title={tr("feedback.fact.reporter")}>
        <Fact label={tr("feedback.fact.sentBy")}>
          <ActorChip name={f.reporter.name ?? tr("feedback.unknownReporter")} kind={f.reporter.agency} />
        </Fact>
        <Fact label={tr("feedback.fact.sent")}>
          <span title={time.dateTime(f.createdAt)}>{time.relative(f.createdAt)}</span>
        </Fact>
        {f.reporters.length > 1 ? (
          <Fact label={tr("feedback.fact.alsoReportedBy")} testId="facts-reporters">
            <span className="grid gap-0.5 text-13">
              {f.reporters.slice(1).map((r) => (
                <span key={r.id}>
                  {r.name ?? tr("feedback.unknownReporter")}
                  {r.from ? <span className="text-12-5 text-muted">{tr("feedback.fact.via", { from: r.from })}</span> : null}
                </span>
              ))}
            </span>
          </Fact>
        ) : null}
        {f.source ? (
          <Fact label={tr("feedback.fact.from")} testId="facts-source">
            <Link
              href={`/projects/${encodeURIComponent(slug)}/automation?tab=reports`}
              className="text-link hover:underline"
              title={tr("feedback.fact.agentReportTitle", { id: f.source.agentReport.id, at: time.dateTime(f.source.agentReport.createdAt) })}
            >
              {tr("feedback.fact.agentReport", { id: f.source.agentReport.id.slice(0, 8) })}
            </Link>
            <span className="text-12-5 text-muted">
              {enumLabel("agentReportKind", f.source.agentReport.kind, language)} · {enumLabel("agentReportTarget", f.source.agentReport.target, language)}
              {f.source.agentReport.targetRef ? ` ${f.source.agentReport.targetRef}` : ""}
            </span>
          </Fact>
        ) : null}
        {f.clarification ? (
          <Fact label={tr("feedback.fact.clarification")}>
            <span className="grid gap-0.5" title={f.clarification.prompt ?? undefined}>
              <StatusBadge family="question" value={f.clarification.status} />
              {f.clarification.answer ? <span className="text-12-5 text-muted">{f.clarification.answer}</span> : null}
            </span>
          </Fact>
        ) : null}
        {f.sensitive ? (
          <Fact label={tr("feedback.fact.data")}>
            <span className="text-12-5" title={tr("feedback.fact.sensitiveHint")}>
              {tr("feedback.fact.sensitive")}
            </span>
          </Fact>
        ) : null}
      </FactsGroup>
    </div>
  );
}
