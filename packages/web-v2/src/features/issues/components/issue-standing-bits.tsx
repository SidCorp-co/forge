"use client";

// What an issue's standing (core `issues/standing.ts`) says, put into the shared design pieces: the
// list row, whose turn as the shared WaitingOn and banner, the step bar, the criteria bar, and the
// facts the peek and the full page's rail show. Nothing here decides whose turn it is.

import {
  ISSUE_ATTENTION_LABELS,
  type IssueStanding,
  type IssueStandingRow,
  type IssueWaitingKind,
  type IssueWaitingOn,
} from "@forge/contracts/issue-standing";
import { WORK_STEP_LABELS, WORK_STEPS } from "@forge/contracts/issue-vocabulary";
import Link from "next/link";
import {
  ActorChip,
  type BannerTone,
  CoverageBar,
  Fact,
  FactsEmpty,
  FactsGroup,
  type ListRowView,
  StatusBadge,
  StepBar,
  WaitBanner,
  WaitingOn,
  type WaitingOnView,
  type WhoKind,
} from "@/design";
import { feedbackHref } from "@/features/feedback/routes";
import { requirementHref } from "@/features/requirements/routes";
import { formatAge, formatRelativeTime, formatStamp } from "@/lib/utils/format";
import { issueHref } from "../routes";

const WHO: Record<IssueWaitingKind, WhoKind | "none"> = {
  you: "you",
  person: "person",
  run: "agent",
  master: "agent",
  issue: "issue",
  release: "release",
  none: "none",
};

export const issueWaitingView = (w: IssueWaitingOn): WaitingOnView => ({ kind: WHO[w.kind], who: w.who, act: w.act, rule: w.rule });

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
    waitingOn: <WaitingOn w={issueWaitingView(r.standing.waitingOn)} />,
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
export function IssueSteps({ standing }: { standing: IssueStanding }) {
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

function EdgeList({ edges, slug, testId }: { edges: IssueStanding["blockedBy"]; slug: string; testId: string }) {
  return (
    <ul className="grid gap-1" data-testid={testId}>
      {edges.map((e) => (
        <li key={e.key} className="flex min-w-0 items-center gap-1.5 text-13">
          <Link href={issueHref(slug, e.key)} className="flex-none font-mono text-12 font-semibold text-link hover:underline">
            {e.key}
          </Link>
          <span className="min-w-0 flex-1 truncate" title={e.title}>
            {e.title}
          </span>
          <StatusBadge family="issue" value={e.status} />
        </li>
      ))}
    </ul>
  );
}

/** The facts the read model adds. `rail` leaves out what the full page's properties already show
 *  (state, module, branch, the dependency lists), so each fact appears once on a page. */
export function IssueStandingFacts({ row, slug, rail }: { row: IssueStandingRow; slug: string; rail?: boolean }) {
  const s = row.standing;
  const c = s.criteria;
  const unjudged = Math.max(0, c.total - c.passing - c.failing - c.skipped);
  return (
    <div data-testid="issue-standing-facts">
      <FactsGroup title={rail ? "Where it stands" : "Status"}>
        {rail ? null : <Fact label="State">{issueBadge(row)}</Fact>}
        {s.attentionGroup !== "done" ? (
          <Fact label="Waiting on">
            <WaitingOn w={issueWaitingView(s.waitingOn)} />
          </Fact>
        ) : null}
        <Fact label="Group">
          <StatusBadge family="attention" value={s.attentionGroup} />
        </Fact>
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
        {!rail && s.module ? (
          <Fact label="Module">
            <span className="truncate font-mono text-12">{s.module.path}</span>
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

      {!rail && (s.blockedBy.length > 0 || s.blocks.length > 0) ? (
        <FactsGroup title="Dependencies">
          {s.blockedBy.length ? (
            <>
              <p className="mb-1 text-12-5 font-medium text-muted">Blocked by</p>
              <EdgeList edges={s.blockedBy} slug={slug} testId="facts-blocked-by" />
            </>
          ) : null}
          {s.blocks.length ? (
            <>
              <p className="mb-1 mt-2 text-12-5 font-medium text-muted">Blocks</p>
              <EdgeList edges={s.blocks} slug={slug} testId="facts-blocks" />
            </>
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
