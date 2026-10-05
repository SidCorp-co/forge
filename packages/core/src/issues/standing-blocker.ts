// The one verdict on why an issue is not moving, and what would move it.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import type { IssueBlocker, IssueEdgeRef } from '@forge/contracts/issue-standing';
import { ISSUE_STATUS_LABELS } from '@forge/contracts/issue-vocabulary';
import type { IssuePark, ParkOwes } from '@forge/contracts/park';
import type { PipelineReading } from './pipeline-health-types.js';

const PARK_OWES: Record<ParkOwes, { reason: string; who: string }> = {
  information: {
    reason: 'This issue is waiting for information — an answer to a question.',
    who: 'Anyone on the project can answer it; the question is below.',
  },
  decision: {
    reason: 'This issue is waiting for a decision — a judgement only a person can make.',
    who: 'Whoever owns the call decides, then resumes it where it stopped.',
  },
  resource: {
    reason:
      'This issue is waiting for something only a person can supply — an account, a credential, or data.',
    who: 'Supply it, then resume it where it stopped.',
  },
};

const ANSWERED = {
  reason: 'The question this issue asked has an answer on the thread.',
  who: 'Resume it where it stopped once the answer is enough to go on.',
};

const NOTHING_TO_RESUME_AT =
  'Nothing says where this issue picks up again — Move anyway… in the status menu lists every move.';
const NOTHING_TO_RESUME_FROM_HOLD =
  'Nothing says where this issue picks up again — the status menu lists every status it may return to.';

const NO_ACT = { label: '', kind: 'none' } as const;
const OPEN_BLOCKER = { label: 'Open blocking issue', kind: 'open_blocker' } as const;
const resumeAct = (at: IssueStatus) =>
  ({ label: `Resume at ${ISSUE_STATUS_LABELS[at]}`, kind: 'resume_park' }) as const;

interface IssueBlockerInput {
  status: IssueStatus;
  leftStatus: IssueStatus | null;
  pausedRun: { runId: string; reading: PipelineReading } | null;
  gate: { reading: PipelineReading } | null;
  park: IssuePark | null;
  /** The standing's live blockers (`IssueStanding.blockedBy`). */
  blockedBy: readonly IssueEdgeRef[];
}

const blocker = (
  b: Pick<IssueBlocker, 'tone' | 'reason' | 'whoMustAct' | 'act'> & Partial<IssueBlocker>,
  blockingRefs: readonly IssueEdgeRef[],
): IssueBlocker => ({
  runId: null,
  resumeAt: null,
  detail: null,
  ...b,
  blockingRefs: [...blockingRefs],
});

function parkBlocker(park: IssuePark, refs: readonly IssueEdgeRef[]): IssueBlocker {
  const copy = park.threadQuestion?.answer ? ANSWERED : PARK_OWES[park.owes];
  if (park.asks) {
    return blocker(
      {
        tone: 'attention',
        reason: copy.reason,
        whoMustAct: PARK_OWES.information.who,
        act: { label: 'Answer it', kind: 'provide_info' },
      },
      refs,
    );
  }
  const at = park.resume.at;
  if (at) {
    return blocker(
      {
        tone: 'attention',
        reason: copy.reason,
        whoMustAct: copy.who,
        act: resumeAct(at),
        resumeAt: at,
      },
      refs,
    );
  }
  return blocker(
    {
      tone: 'attention',
      reason: copy.reason,
      whoMustAct: copy.who,
      act: NO_ACT,
      detail: NOTHING_TO_RESUME_AT,
    },
    refs,
  );
}

// a blocker whose change has landed holds its dependents until its criteria pass (ISS-54), so what
// holds this issue is that blocker's judge, never "finish the blocking issue" (ISS-80)
function blocksBlocker(refs: readonly IssueEdgeRef[]): IssueBlocker {
  const keys = refs.map((r) => r.key).join(', ');
  const one = refs.length === 1;
  if (refs.every((r) => r.designHold)) {
    return blocker(
      {
        tone: 'info',
        reason: `Blocked by ${keys}, which ${one ? 'delivers a design' : 'deliver designs'} not yet approved: ${refs.map((r) => r.designHold).join('; ')}.`,
        whoMustAct: `The design approver decides the revision ${keys} ${one ? 'delivers' : 'deliver'}; this issue is released once it is approved.`,
        act: OPEN_BLOCKER,
      },
      refs,
    );
  }
  if (refs.every((r) => r.landed)) {
    return blocker(
      {
        tone: 'info',
        reason: `Blocked by ${keys}, which ${one ? 'has' : 'have'} landed and ${one ? 'waits' : 'wait'} on a judge.`,
        whoMustAct: `A judge records a verdict on each criterion of ${keys}; this issue is released once ${one ? 'it passes' : 'they pass'}.`,
        act: OPEN_BLOCKER,
      },
      refs,
    );
  }
  return blocker(
    {
      tone: 'info',
      reason: `Blocked by ${refs.length} open issue${one ? '' : 's'}.`,
      whoMustAct: 'Finish the blocking issue(s) first.',
      act: OPEN_BLOCKER,
    },
    refs,
  );
}

// the one verdict on why an issue is not moving, richest signal first: a paused run, the park view
// (every park shape, and an open question at any status), on_hold, a gate on its queued step, its
// live blockers; null when it is moving
export function issueBlockerOf(input: IssueBlockerInput): IssueBlocker | null {
  const refs = input.blockedBy;
  const paused = input.pausedRun;
  if (paused) {
    const r = paused.reading;
    return blocker(
      {
        tone: r.needsAction ? 'attention' : 'info',
        reason: r.detail,
        whoMustAct: r.who,
        act: r.needsAction ? { label: 'Resume run', kind: 'resume_run' } : NO_ACT,
        runId: r.needsAction ? paused.runId : null,
      },
      refs,
    );
  }
  if (input.park) return parkBlocker(input.park, refs);
  if (input.status === 'needs_info') {
    return blocker(
      {
        tone: 'attention',
        reason: 'This issue is stopped until a person acts.',
        whoMustAct: 'What it waits on could not be read — read the thread.',
        act: NO_ACT,
      },
      refs,
    );
  }
  if (input.status === 'on_hold') {
    const base = {
      tone: 'info' as const,
      reason: 'The issue is paused.',
      whoMustAct: 'An operator can resume it when the work is wanted again.',
    };
    return input.leftStatus
      ? blocker({ ...base, act: resumeAct(input.leftStatus), resumeAt: input.leftStatus }, refs)
      : blocker({ ...base, act: NO_ACT, detail: NOTHING_TO_RESUME_FROM_HOLD }, refs);
  }
  if (input.gate) {
    const r = input.gate.reading;
    return blocker(
      {
        tone: r.needsAction ? 'attention' : 'info',
        reason: r.detail,
        whoMustAct: r.who,
        act: refs.length ? OPEN_BLOCKER : NO_ACT,
      },
      refs,
    );
  }
  return refs.length ? blocksBlocker(refs) : null;
}
