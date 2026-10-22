// What forge_requirements answers for one requirement: the screen's own read, cut to what a BA acts
// on, and the progress block (`product-progress.ts`) composed from its standing and its forecast.

import type { ScopeForecast } from '@forge/contracts/forecast';
import type {
  RequirementDetail,
  RequirementState,
  RequirementSummary,
} from '@forge/contracts/requirements';
import type { RunStanding } from '@forge/contracts/run-standing';
import {
  type Progress,
  type ProgressWait,
  pausedWait,
  progressOf,
} from '../product-progress/index.js';

/** Why a requirement with no issue has no estimate, by where it stands. */
const NO_ISSUE: Record<RequirementState, string> = {
  draft: 'it is a draft, and issues are planned only after a person agrees it',
  agreed: 'no issue carries it yet: it is agreed and waits to be broken down into issues',
  in_delivery: 'no live issue carries it',
  delivered: 'no live issue carries it',
  accepted: 'no live issue carries it',
  deferred: 'it is deferred out of the current release, so no work is planned for it',
  dropped: 'it was dropped, so nothing will be built',
};

const TASK_ACT = {
  breakdown: 'break it down into issues',
  check: 'check its business criteria',
  're-plan': 're-plan',
} as const;

type Standing = RequirementSummary['standing'];

/** Whom the requirement itself waits on, by its standing's times, and the open tasks of its delivery with their due dates. */
function standingWaits(s: Standing): ProgressWait[] {
  const out: ProgressWait[] = [];
  if (s.waitingOn.kind !== 'none' || s.times.stuck) {
    out.push({
      who: s.waitingOn.who,
      act: s.waitingOn.act,
      // a stuck requirement says why in one sentence, the issue it was carried from named (REQ-48 BC-8)
      why: s.times.stuck?.reason ?? s.waitingOn.rule,
      ref: s.waitingOn.ref,
      at: s.times.dueAt,
      late: s.times.stuck?.code === 'overdue',
    });
  }
  for (const t of s.tasks) {
    const issue = t.kind === 're-plan' ? t.displayId : null;
    out.push({
      who: t.owner,
      act: issue ? `${TASK_ACT[t.kind]} ${issue}` : TASK_ACT[t.kind],
      why: `the ${t.kind} task of revision ${t.revision}`,
      ref: issue,
      at: t.dueAt,
      late: t.overdue,
    });
  }
  return out;
}

/**
 * The progress block of one requirement. `scope` is its forecast, null where the forecast reads none
 * (a dropped requirement); `asOf` stamps the block when it does.
 */
export function requirementProgress(
  r: Pick<RequirementSummary, 'standing'>,
  scope: ScopeForecast | null,
  runs: readonly RunStanding[],
  asOf: string,
): Progress {
  return progressOf({
    asOf: scope?.asOf ?? asOf,
    work: scope && scope.progress.total > 0 ? scope.progress : null,
    runs,
    waits: [...standingWaits(r.standing), ...(scope?.next ? [pausedWait(scope.next)] : [])],
    delivery: scope?.delivery ?? null,
    noDelivery: NO_ISSUE[r.standing.state],
  });
}

const waitOf = (s: Standing) => ({
  who: s.waitingOn.who,
  act: s.waitingOn.act,
  why: s.waitingOn.rule,
});

/** One row of the list. */
export function requirementRow(r: RequirementSummary, progress: Progress) {
  return {
    key: r.key,
    title: r.title,
    state: r.standing.state,
    next: r.standing.next,
    waitingOn: waitOf(r.standing),
    currentRevision: r.currentRevision,
    latestRevision: r.latestRevision,
    criteria: {
      proven: r.delivery.criteriaCoverage.passing,
      judged: r.delivery.criteriaCoverage.judged,
      total: r.delivery.criteriaCoverage.criteria,
    },
    area: r.area?.name ?? null,
    touchedAt: r.standing.touchedAt,
    progress,
  };
}

/** One requirement in full, as a BA reads it before revising it or telling someone where it is. */
export function requirementDetail(d: RequirementDetail, progress: Progress) {
  const latest = d.revisions[0] ?? null;
  const open = latest && (latest.state === 'draft' || latest.state === 'proposed') ? latest : null;
  return {
    key: d.key,
    title: d.title,
    state: d.standing.state,
    next: d.standing.next,
    waitingOn: waitOf(d.standing),
    currentRevision: d.currentRevision,
    openRevision: open ? { revision: open.revision, state: open.state } : null,
    revision: latest && {
      revision: latest.revision,
      state: latest.state,
      baseRevision: latest.baseRevision,
      kind: latest.kind,
      reason: latest.reason,
      tldr: latest.tldr,
      changeSummary: latest.changeSummary,
      spec: latest.spec,
      criteria: latest.criteria.map((c) => ({ code: c.code, body: c.body, form: c.form })),
    },
    revisions: d.revisions.map((v) => ({
      revision: v.revision,
      state: v.state,
      author: v.authorName,
      createdAt: v.createdAt,
    })),
    questions: d.questions.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      status: q.status,
      whoAnswers: q.whoAnswers,
      blocking: q.blocking,
      answer: q.answer,
    })),
    unclear: d.unclear,
    coverage: d.delivery.criteriaCoverage,
    issues: d.issues.map((i) => ({
      key: i.displayId,
      title: i.title,
      status: i.status,
      shippedIn: i.shippedIn,
      landedIn: i.landedIn,
    })),
    releases: d.releases,
    feedback: d.feedback.map((f) => ({ key: f.key, title: f.title, phase: f.phase, open: f.open })),
    deferral: d.deferral,
    canSignOff: d.canSignOff,
    progress,
  };
}
