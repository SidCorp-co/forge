"use client";

// The at-a-glance facts of one feedback item: its phase and whose turn, what it is about, what carries
// it, and who sent it. The full page's sticky rail and the peek draw this one component, so the main
// column holds only what the reporter said, the acts, and the history.

import Link from "next/link";
import { ActorChip, EnumBadge, enumLabel, Fact, FactsEmpty, FactsGroup, StatusBadge, type StatusFamily, StepBar, WaitBanner, WaitingOn } from "@/design";
import { requirementHref } from "@/features/requirements/routes";
import { issueHref } from "@/features/issues/routes";
import { formatRelativeTime, formatStamp } from "@/lib/utils/format";
import { feedbackHref } from "../routes";
import type { FeedbackPhase, FeedbackRoute, FeedbackView } from "../types";
import { FEEDBACK_ATTENTION_LABELS, FEEDBACK_PHASE_LABELS } from "@forge/contracts/feedback";

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

/** One line at the top of the page and the peek: whom it waits on, from core's read model. */
export function FeedbackBanner({ f, className }: { f: FeedbackView; className?: string }) {
  const w = f.waitingOn;
  const g = f.attentionGroup;
  const tone = FEEDBACK_ATTENTION_LABELS[g].tone;
  return (
    <WaitBanner
      tone={g === "waiting" || g === "done" ? "calm" : tone}
      head={g === "done" ? `${FEEDBACK_PHASE_LABELS[f.phase]}.` : `Waiting on ${w.kind === "you" ? "you" : w.who}:`}
      body={g === "done" ? "Nothing is owed on it." : w.act || w.who}
      rule={w.rule}
      className={className}
    />
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

export function FeedbackFacts({ f, slug }: { f: FeedbackView; slug: string }) {
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
              {r.key && carrierType !== "other" ? <KeyLink type={carrierType} k={r.key} slug={slug} /> : null}
              {r.status && CARRIER_FAMILY[r.route] ? <StatusBadge family={CARRIER_FAMILY[r.route] as StatusFamily} value={r.status} /> : null}
            </span>
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
