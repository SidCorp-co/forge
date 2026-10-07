// The one verdict on why an issue is not moving, and what would move it.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import type { IssueBlocker, IssueBlockerAct, IssueEdgeRef } from '@forge/contracts/issue-standing';
import type { IssuePark, ParkOwes } from '@forge/contracts/park';
import { type Said, say, sayEn } from '@forge/contracts/said';
import { answeredWait } from './answered-wait.js';
import type { PipelineReading } from './pipeline-health-types.js';

const PARK_OWES: Record<ParkOwes, { reason: Said; who: Said }> = {
  information: {
    reason: say('issues.blocker.owesInformation'),
    who: say('issues.blocker.whoInformation'),
  },
  decision: {
    reason: say('issues.blocker.owesDecision'),
    who: say('issues.blocker.whoDecision'),
  },
  resource: {
    reason: say('issues.blocker.owesResource'),
    who: say('issues.blocker.whoResource'),
  },
};

const ANSWERED = {
  reason: say('issues.blocker.answered'),
  who: say('issues.blocker.whoAnswered'),
};

const NOTHING_TO_RESUME_AT = say('issues.blocker.noResumeAt');
const NOTHING_TO_RESUME_FROM_HOLD = say('issues.blocker.noResumeFromHold');

interface Act {
  kind: IssueBlockerAct;
  label: Said | null;
}
const NO_ACT: Act = { label: null, kind: 'none' };
const OPEN_BLOCKER: Act = { label: say('issues.blocker.actOpenBlocker'), kind: 'open_blocker' };
const resumeAct = (at: IssueStatus): Act => ({
  label: say('issues.blocker.actResumeAt', { status: at }),
  kind: 'resume_park',
});

interface IssueBlockerInput {
  status: IssueStatus;
  leftStatus: IssueStatus | null;
  pausedRun: { runId: string; reading: PipelineReading } | null;
  gate: { reading: PipelineReading } | null;
  park: IssuePark | null;
  /** The standing's live blockers (`IssueStanding.blockedBy`). */
  blockedBy: readonly IssueEdgeRef[];
}

interface BlockerSaid {
  tone: IssueBlocker['tone'];
  reason: Said;
  whoMustAct: Said;
  act: Act;
  detail?: Said;
  runId?: string | null;
  resumeAt?: IssueStatus | null;
}

/** A blocker from what it says: its English sentences rendered from `says`, never written beside it. */
const blocker = (b: BlockerSaid, blockingRefs: readonly IssueEdgeRef[]): IssueBlocker => ({
  tone: b.tone,
  reason: sayEn(b.reason),
  whoMustAct: sayEn(b.whoMustAct),
  act: { label: b.act.label ? sayEn(b.act.label) : '', kind: b.act.kind },
  runId: b.runId ?? null,
  resumeAt: b.resumeAt ?? null,
  blockingRefs: [...blockingRefs],
  detail: b.detail ? sayEn(b.detail) : null,
  says: {
    reason: b.reason,
    whoMustAct: b.whoMustAct,
    act: b.act.label,
    detail: b.detail ?? null,
  },
});

function parkBlocker(park: IssuePark, refs: readonly IssueEdgeRef[]): IssueBlocker {
  const copy = park.threadQuestion?.answer ? ANSWERED : PARK_OWES[park.owes];
  if (park.asks) {
    return blocker(
      {
        tone: 'attention',
        reason: copy.reason,
        whoMustAct: PARK_OWES.information.who,
        act: { label: say('issues.blocker.actAnswer'), kind: 'provide_info' },
      },
      refs,
    );
  }
  const at = park.resume.at;
  if (park.answered) {
    const wait = answeredWait(park.answered);
    const act =
      wait.on === 'issue' ? OPEN_BLOCKER : wait.on === 'person' && at ? resumeAct(at) : NO_ACT;
    return blocker(
      {
        tone: wait.on === 'person' ? 'attention' : 'info',
        reason: wait.reason,
        whoMustAct: wait.who,
        act,
        ...(act.kind === 'resume_park' && at ? { resumeAt: at } : {}),
        ...(wait.on === 'person' && !at ? { detail: NOTHING_TO_RESUME_AT } : {}),
      },
      refs,
    );
  }
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
    const holds = refs.map((r) => r.designHold).join('; ');
    return blocker(
      {
        tone: 'info',
        reason: say(one ? 'issues.blocker.designOne' : 'issues.blocker.designMany', { keys, holds }),
        whoMustAct: say(one ? 'issues.blocker.whoDesignOne' : 'issues.blocker.whoDesignMany', {
          keys,
        }),
        act: OPEN_BLOCKER,
      },
      refs,
    );
  }
  if (refs.every((r) => r.landed)) {
    return blocker(
      {
        tone: 'info',
        reason: say(one ? 'issues.blocker.landedOne' : 'issues.blocker.landedMany', { keys }),
        whoMustAct: say(one ? 'issues.blocker.whoLandedOne' : 'issues.blocker.whoLandedMany', {
          keys,
        }),
        act: OPEN_BLOCKER,
      },
      refs,
    );
  }
  return blocker(
    {
      tone: 'info',
      reason: one
        ? say('issues.blocker.openOne')
        : say('issues.blocker.openMany', { n: refs.length }),
      whoMustAct: say('issues.blocker.finishBlockers'),
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
        reason: r.says.detail,
        whoMustAct: r.says.who,
        act: r.needsAction
          ? { label: say('issues.blocker.actResumeRun'), kind: 'resume_run' }
          : NO_ACT,
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
        reason: say('issues.blocker.stopped'),
        whoMustAct: say('issues.blocker.unreadable'),
        act: NO_ACT,
      },
      refs,
    );
  }
  if (input.status === 'on_hold') {
    const base = {
      tone: 'info' as const,
      reason: say('issues.blocker.paused'),
      whoMustAct: say('issues.blocker.whoPaused'),
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
        reason: r.says.detail,
        whoMustAct: r.says.who,
        act: refs.length ? OPEN_BLOCKER : NO_ACT,
      },
      refs,
    );
  }
  return refs.length ? blocksBlocker(refs) : null;
}
