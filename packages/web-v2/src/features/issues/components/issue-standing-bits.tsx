"use client";

// What an issue's standing (core `issues/standing.ts`) says, put into the shared design pieces: the
// list row, whose turn as the shared WaitingOn and banner, the step bar, the criteria bar, and the
// facts the peek and the full page's rail show. Nothing here decides whose turn it is.

import {
  ISSUE_ATTENTION_LABELS,
  type IssueStanding,
  type IssueStandingRow,
} from "@forge/contracts/issue-standing";
import { WORK_STEP_LABELS, WORK_STEPS } from "@forge/contracts/issue-vocabulary";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  ActorChip,
  type BannerTone,
  CoverageBar,
  Fact,
  FactsEmpty,
  FactsGroup,
  type ListRowView,
  MarkStrip,
  type MarkView,
  StatusBadge,
  statusReading,
  StepBar,
  WaitBanner,
  WaitingOn,
} from "@/design";
import { feedbackHref } from "@/lib/routes/feedback";
import { requirementHref } from "@/lib/routes/requirements";
import { formatAge, formatRelativeTime, formatStamp } from "@/lib/utils/format";
import { issueHref } from "../../../lib/routes/issues";

export const issueBadge = (r: Pick<IssueStandingRow, "status" | "standing">) => (
  <StatusBadge family="issue" value={r.status} step={r.standing.step} tone={r.standing.tone} />
);

/** The secondary line: module, the requirement and its criteria, a high priority, where it came from, criteria passing. */
function factsLine(r: IssueStandingRow): string[] {
  const s = r.standing;
  const parts: string[] = [];
  if (s.module) parts.push(s.module.path);
  if (s.requirement) parts.push(`${s.requirement.key}${s.requirement.criteria.length ? ` ${s.requirement.criteria.join(", ")}` : ""}`);
  if (r.priority === "high" || r.priority === "critical") parts.push(`${r.priority === "critical" ? "Critical" : "High"} priority`);
  if (s.feedback[0]) parts.push(`From ${s.feedback[0]}`);
  if (s.criteria.total > 0) parts.push(`Passing ${s.criteria.passing}/${s.criteria.total}`);
  return parts;
}

export const issueRowView =
  (slug: string) =>
  (r: IssueStandingRow): ListRowView => ({
    key: r.key,
    href: issueHref(slug, r.key),
    title: r.title,
    facts: factsLine(r),
    state: issueBadge(r),
    waitingOn: <WaitingOn w={r.standing.waitingOn} />,
    owner: r.standing.owner ? (
      <ActorChip name={r.standing.owner.name ?? "Unknown"} kind={r.standing.owner.kind} size={20} />
    ) : (
      <span className="text-subtle">No owner</span>
    ),
    age: { text: formatAge(r.standing.touchedAt), title: `Last activity ${formatStamp(r.standing.touchedAt)}` },
    dim: r.standing.attentionGroup === "done",
  });

const BANNER: Record<IssueStanding["attentionGroup"], BannerTone> = {
  needs_you: "you",
  moving: "agent",
  stuck: "blocked",
  queued: "calm",
  paused: "calm",
  done: "calm",
};

/** The peek's one line: whom the issue waits on and for what, the rule on hover. */
export function IssueBanner({ standing, className }: { standing: IssueStanding; className?: string }) {
  const w = standing.waitingOn;
  const g = standing.attentionGroup;
  return (
    <WaitBanner
      tone={BANNER[g]}
      head={g === "done" ? `${ISSUE_ATTENTION_LABELS.done.label}.` : g === "stuck" ? "Stuck:" : `Waiting on ${w.kind === "you" ? "you" : w.who}:`}
      body={g === "done" ? "Nothing is owed on it." : g === "stuck" ? `${w.who}${w.act ? ` · ${w.act}` : ""}` : w.act}
      rule={w.rule}
      className={className}
      testId="issue-banner"
    />
  );
}

/** Triage → … → Release with the current step lit; an issue past release is all done. */
function IssueSteps({ standing }: { standing: IssueStanding }) {
  const over = standing.state === "awaiting_release" || standing.state === "closed";
  const at = standing.step ? WORK_STEPS.indexOf(standing.step) : -1;
  if (!over && at < 0) return null;
  return (
    <StepBar
      steps={WORK_STEPS.map((step, i) => ({
        key: step,
        label: WORK_STEP_LABELS[step],
        state: over || i < at ? "done" : i === at ? "now" : "next",
        tone: standing.tone === "you" ? "you" : "run",
      }))}
      caption={
        !over && standing.stepStartedAt ? (
          <span title={formatStamp(standing.stepStartedAt)}>
            {WORK_STEP_LABELS[standing.step as (typeof WORK_STEPS)[number]]} since {formatRelativeTime(standing.stepStartedAt)}
          </span>
        ) : undefined
      }
    />
  );
}

/** One mark per step and per criterion, the peek's at-a-glance strip: "Steps ▮▮▮▯ Test · Criteria ▮▮▯▯ 2 of 4 pass". */
export function IssueStrip({ standing }: { standing: IssueStanding }) {
  const over = standing.state === "awaiting_release" || standing.state === "closed";
  const at = standing.step ? WORK_STEPS.indexOf(standing.step) : -1;
  const c = standing.criteria;
  const unjudged = Math.max(0, c.total - c.passing - c.failing - c.skipped);
  const crit: MarkView[] = [
    ...Array.from({ length: c.passing }, (_, i) => ({ key: `p${i}`, label: "Passing", tone: "ready" as const })),
    ...Array.from({ length: c.failing }, (_, i) => ({ key: `f${i}`, label: "Failing", tone: "err" as const })),
    ...Array.from({ length: c.skipped }, (_, i) => ({ key: `s${i}`, label: "Skipped", tone: "neutral" as const })),
    ...Array.from({ length: unjudged }, (_, i) => ({ key: `u${i}`, label: "Not judged" })),
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-12 text-muted" data-testid="issue-strip">
      {over || at >= 0 ? (
        <span className="inline-flex items-center gap-2">
          Steps
          <MarkStrip
            size="sm"
            marks={WORK_STEPS.map((step, i) => ({
              key: step,
              label: `${WORK_STEP_LABELS[step]} · ${over || i < at ? "done" : i === at ? "current step" : "not yet"}`,
              fill: over || i < at ? "var(--ink-600)" : i === at ? undefined : "var(--paper-300)",
              tone: i === at && !over ? (standing.tone === "you" ? "you" : "run") : undefined,
            }))}
          />
          <span className="text-fg">{over ? "Done" : WORK_STEP_LABELS[standing.step as (typeof WORK_STEPS)[number]]}</span>
        </span>
      ) : null}
      <span className="inline-flex items-center gap-2">
        Criteria
        {c.total ? (
          <>
            <MarkStrip size="sm" marks={crit} />
            <span className="text-fg">
              {c.passing} of {c.total} pass
            </span>
          </>
        ) : (
          <span className="text-subtle">None yet</span>
        )}
      </span>
    </div>
  );
}

/** The peek's facts, each once and each beside where it comes from: whom it waits on, the
 *  requirement it serves, its module, its branch, its owner. State and whose turn are the head's
 *  and the banner's, so they are not repeated here. */
export function IssuePeekFacts({ row, slug }: { row: IssueStandingRow; slug: string }) {
  const s = row.standing;
  const sub = (t: ReactNode) => <span className="mt-0.5 block text-12 text-subtle">{t}</span>;
  return (
    <div className="divide-y divide-line-subtle" data-testid="issue-peek-facts">
      {s.attentionGroup !== "done" ? (
        <Fact label="Waits on">
          <span className="min-w-0">
            <WaitingOn w={s.waitingOn} />
            {s.waitingOn.rule ? sub(s.waitingOn.rule.charAt(0).toUpperCase() + s.waitingOn.rule.slice(1)) : null}
          </span>
        </Fact>
      ) : null}
      {s.requirement ? (
        <Fact label="Requirement">
          <span className="min-w-0">
            <Link href={requirementHref(slug, s.requirement.key)} className="font-mono text-12 font-semibold text-link hover:underline">
              {s.requirement.key}
            </Link>
            {s.requirement.criteria.length ? <span className="ml-1.5 font-mono text-12">{s.requirement.criteria.join(", ")}</span> : null}
            {s.requirement.changedSincePlan ? (
              <span className="ml-1.5 text-12-5" data-testid="changed-since-plan">
                · planned on r{s.requirement.plannedRevision}, now r{s.requirement.currentRevision}
              </span>
            ) : null}
            {sub(s.requirement.title)}
          </span>
        </Fact>
      ) : null}
      {s.module ? (
        <Fact label="Module">
          <span className="min-w-0">
            <span className="font-mono text-12">{s.module.path}</span>
            {sub(s.module.name)}
          </span>
        </Fact>
      ) : null}
      {s.branch ? (
        <Fact label="Branch">
          <span className="min-w-0">
            <span className="font-mono text-12">
              {s.branch}
              {s.headSha ? ` · ${s.headSha.slice(0, 7)}` : ""}
            </span>
            {s.lease?.holder ? sub(`${s.lease.holder} · lease ${statusReading("lease", s.lease.verdict).label.toLowerCase()}`) : null}
          </span>
        </Fact>
      ) : null}
      <Fact label="Owner">
        {s.owner ? <ActorChip name={s.owner.name ?? "Unknown"} kind={s.owner.kind} /> : <span className="text-subtle">No owner</span>}
      </Fact>
      {s.blocks.length ? (
        <Fact label="Blocks">
          <span className="flex min-w-0 flex-wrap gap-x-2">
            {s.blocks.map((b) => (
              <Link key={b.key} href={issueHref(slug, b.key)} className="font-mono text-12 font-semibold text-link hover:underline" title={b.title}>
                {b.key}
              </Link>
            ))}
          </span>
        </Fact>
      ) : null}
      {s.feedback.length ? (
        <Fact label="From">
          <span className="flex min-w-0 flex-wrap gap-x-2">
            {s.feedback.map((k) => (
              <Link key={k} href={feedbackHref(slug, k)} className="font-mono text-12 font-semibold text-link hover:underline">
                {k}
              </Link>
            ))}
          </span>
        </Fact>
      ) : null}
    </div>
  );
}

export function IssueStandingFacts({ row, slug }: { row: IssueStandingRow; slug: string }) {
  const s = row.standing;
  const c = s.criteria;
  const unjudged = Math.max(0, c.total - c.passing - c.failing - c.skipped);
  return (
    <div data-testid="issue-standing-facts">
      <FactsGroup title="Where it stands">
        <Fact label="Owner">
          {s.owner ? <ActorChip name={s.owner.name ?? "Unknown"} kind={s.owner.kind} /> : <span className="text-subtle">No owner</span>}
        </Fact>
        {s.lease ? (
          <Fact label="Lease">
            <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
              <StatusBadge family="lease" value={s.lease.verdict} />
              {s.lease.holder ? <span className="truncate font-mono text-12">{s.lease.holder}</span> : null}
            </span>
          </Fact>
        ) : null}
        <Fact label="Last activity">
          <span title={formatStamp(s.touchedAt)}>{formatRelativeTime(s.touchedAt)}</span>
        </Fact>
        <div className="pt-2.5">
          <IssueSteps standing={s} />
        </div>
      </FactsGroup>

      <FactsGroup title="Criteria" count={c.total ? `Passing ${c.passing} of ${c.total}` : undefined} testId="facts-criteria">
        {c.total === 0 ? (
          <FactsEmpty>No criteria yet; the plan step writes them.</FactsEmpty>
        ) : (
          <CoverageBar
            segments={[
              { key: "pass", label: "Passing", count: c.passing, tone: "ready" },
              { key: "fail", label: "Failing", count: c.failing, tone: "err" },
              { key: "skipped", label: "Skipped", count: c.skipped, tone: "neutral" },
              { key: "unjudged", label: "Not judged", count: unjudged },
            ]}
          />
        )}
      </FactsGroup>

      {s.requirement ? (
        <FactsGroup title="Requirement" testId="facts-requirement">
          <div className="flex min-w-0 items-center gap-1.5 text-13">
            <Link href={requirementHref(slug, s.requirement.key)} className="flex-none font-mono text-12 font-semibold text-link hover:underline">
              {s.requirement.key}
            </Link>
            <span className="min-w-0 flex-1 truncate" title={s.requirement.title}>
              {s.requirement.title}
            </span>
          </div>
          {s.requirement.criteria.length ? <p className="mt-1 font-mono text-12 text-muted">Traces to {s.requirement.criteria.join(", ")}</p> : null}
          {s.requirement.changedSincePlan ? (
            <p className="mt-1 text-12-5" data-testid="changed-since-plan">
              Planned on r{s.requirement.plannedRevision}; the requirement is now r{s.requirement.currentRevision}.
            </p>
          ) : null}
        </FactsGroup>
      ) : null}

      {s.feedback.length ? (
        <FactsGroup title="Feedback" count={`Reports ${s.feedback.length}`}>
          <div className="flex flex-wrap gap-2">
            {s.feedback.map((k) => (
              <Link key={k} href={feedbackHref(slug, k)} className="font-mono text-12 font-semibold text-link hover:underline">
                {k}
              </Link>
            ))}
          </div>
        </FactsGroup>
      ) : null}
    </div>
  );
}
