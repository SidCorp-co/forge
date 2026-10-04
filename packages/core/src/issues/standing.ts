/**
 * Where an issue stands, derived from what was read and nothing else: the attention group the
 * list puts it under, whom it waits on and for what, its status tone on this project, and the wave
 * it sits in over the open `blocks` edges. Pure, so every rule below is a unit test;
 * `standing-read.ts` gathers the facts.
 */

import type { IssuePark, ParkOwes } from '@forge/contracts';
import type { IssueStatus } from '@forge/contracts/issue-machine';
import {
  ISSUE_RESOLVED_STATUSES,
  ISSUE_TERMINAL_STATUSES,
  issueMovesFrom,
} from '@forge/contracts/issue-machine';
import type {
  IssueAttentionGroup,
  IssueBlocker,
  IssueCriteriaTally,
  IssueEdgeRef,
  IssueLeaseView,
  IssueModuleRef,
  IssueRequirementRef,
  IssueStanding,
  IssueStepHandoff,
  IssueStepOutcome,
  IssueWaitingKind,
} from '@forge/contracts/issue-standing';
import {
  ISSUE_STATUS_LABELS,
  type IssueStatusTone,
  issueStatusToneOn,
  type WorkStep,
} from '@forge/contracts/issue-vocabulary';
import type { WaitingOn } from '@forge/contracts/standing';
import type { PipelineReading } from './pipeline-health-types.js';
import { landedWait } from './strand-rules.js';

/** Settled blockers release their dependents (`dependency-effects.ts:BLOCKER_SETTLED_STATUSES`). */
const SETTLED: readonly string[] = ISSUE_RESOLVED_STATUSES;
const DONE: readonly string[] = ISSUE_TERMINAL_STATUSES;

const STEP_WORD: Record<WorkStep, string> = {
  triage: 'Triage',
  clarify: 'Clarify',
  plan: 'Plan',
  build: 'Build',
  test: 'Test',
  release: 'Release',
};

const NEEDS_INFO_ACT: Record<string, string> = {
  needs_answer: 'answer a question',
  needs_decision: 'make a decision',
  needs_resource: 'supply what it asks for',
};

export interface StandingEdge {
  /** The other issue's id, key, title and status. */
  id: string;
  key: string;
  title: string;
  status: IssueStatus;
  merged: boolean;
  step: WorkStep | null;
  designHold?: string | null | undefined;
  /** The blocker of this edge still holds (`blocked-by.ts:blockerUnsettledSql`). */
  holds: boolean;
}

export interface IssueStandingInput {
  status: IssueStatus;
  /** The status a park left (`issue_work_state.left_status`), which its return move goes to. */
  leftStatus: IssueStatus | null;
  /** This issue holds its dependents (`blocked-by.ts:blockerUnsettledSql`). */
  holdsDependents: boolean;
  waitingKind: string | null;
  merged: boolean;
  step: WorkStep | null;
  stepStartedAt: Date | null;
  lease: IssueLeaseView | null;
  inFlight: boolean;
  /** An open `human` question on it (`questions/issue-coupling.ts:holdsOpenHumanQuestion`). */
  owesAnswer: boolean;
  /** Live `blocks` edges into this issue (expired edges are left out by the reader). */
  blockedBy: readonly StandingEdge[];
  /** Live `blocks` edges out of it. */
  blocks: readonly StandingEdge[];
  criteria: IssueCriteriaTally;
  requirement: IssueRequirementRef | null;
  module: IssueModuleRef | null;
  feedback: readonly string[];
  branch: string | null;
  headSha: string | null;
  owner: IssueStanding['owner'];
  touchedAt: Date;
  /** Whether the project requires a person to approve a release (`release.approval.required`). */
  releaseApproval: boolean;
  /** Null for a reader with no person behind it; nothing then reads as theirs. */
  viewer: { userId: string; canWrite: boolean } | null;
  now: Date;
}

type IssueWaitingOn = WaitingOn<IssueWaitingKind>;

const wait = (
  kind: IssueWaitingKind,
  who: string,
  act: string,
  rule: string,
  ref: string | null = null,
): IssueWaitingOn => ({ kind, who, act, rule, ref, dueAt: null });

/** The badge tone of a status on this project (contracts `issueStatusToneOn`). */
export function toneOf(status: IssueStatus, releaseApproval: boolean): IssueStatusTone {
  return issueStatusToneOn(status, releaseApproval);
}

const minutesSince = (from: Date | null, now: Date) =>
  from ? Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000)) : null;

function forPerson(
  viewer: IssueStandingInput['viewer'],
  act: string,
  rule: string,
): { group: IssueAttentionGroup; waitingOn: IssueWaitingOn } {
  return viewer?.canWrite
    ? { group: 'needs_you', waitingOn: wait('you', 'You', act, rule) }
    : { group: 'needs_you', waitingOn: wait('person', 'A project writer', act, rule) };
}

const held = (lease: IssueLeaseView | null) =>
  lease !== null && (lease.verdict === 'live' || lease.verdict === 'shared');

// cm:why whose turn it is, first rule that holds wins: closed or dropped → done; on_hold → paused;
// needs_info or an open human question → a person answers; draft → a person takes it on or drops
// it; awaiting_release → the master while a criterion no longer passes, else a person approves
// where the project requires it, else queued for the release; a live lease or a job in flight →
// moving; a live unsettled blocker → stuck on the first, worded as waiting on its judge where its
// change landed; a landed row nothing holds → queued for its judge
// (`strand-rules.ts:landedWait`); in_progress with no holder or reopen → stuck; open or
// approved → queued for a master slot.
function turnOf(input: IssueStandingInput): {
  group: IssueAttentionGroup;
  waitingOn: IssueWaitingOn;
} {
  const { status, viewer } = input;
  if (status === 'closed' || status === 'dropped') {
    return {
      group: 'done',
      waitingOn: wait(
        'none',
        'Nobody',
        status === 'closed' ? 'shipped' : 'dropped',
        `the issue is ${status}`,
      ),
    };
  }
  if (status === 'on_hold') {
    const r = forPerson(viewer, 'resume it', 'a person paused it; a person resumes it');
    return { group: 'paused', waitingOn: r.waitingOn };
  }
  if (status === 'needs_info') {
    return forPerson(
      viewer,
      NEEDS_INFO_ACT[input.waitingKind ?? ''] ?? 'answer a question',
      'parked at needs_info: a person owes the answer; it wakes the master',
    );
  }
  if (input.owesAnswer) {
    return forPerson(
      viewer,
      'answer a question',
      'a run asked a question only a person can answer',
    );
  }
  if (status === 'draft') {
    return forPerson(viewer, 'take on or drop', 'a draft is not work until a person accepts it');
  }
  const running = held(input.lease) || input.inFlight;
  if (status === 'awaiting_release') {
    const { total, passing } = input.criteria;
    if (passing < total) {
      return {
        group: 'stuck',
        waitingOn: wait(
          'master',
          'Master',
          'judge it again',
          `${total - passing} of ${total} criteria have no verdict that passes now, such as one judged on a storefront draft the source has moved past or cannot read back; the release hold keeps it until a run judges them again`,
        ),
      };
    }
    if (input.releaseApproval) {
      return forPerson(
        viewer,
        'approve the release',
        'every criterion passed; this project requires a person to approve a release',
      );
    }
    return running
      ? { group: 'moving', waitingOn: wait('run', 'Release', 'running', 'a release run holds it') }
      : {
          group: 'queued',
          waitingOn: wait(
            'release',
            'Release',
            'next release',
            'every criterion passed; the project releases without an approval',
          ),
        };
  }
  if (running) {
    const step = input.step ? STEP_WORD[input.step] : null;
    const mins = minutesSince(input.stepStartedAt, input.now);
    const act = [step, mins !== null && step ? `${mins} min` : null].filter(Boolean).join(' · ');
    return {
      group: 'moving',
      waitingOn: wait(
        'run',
        held(input.lease) ? 'Run' : 'Queued run',
        act || (held(input.lease) ? 'working' : 'starting'),
        held(input.lease)
          ? `lease held by ${input.lease?.holder ?? 'a run'}`
          : 'a job or run is queued or running on it',
      ),
    };
  }
  const blocker = input.blockedBy.find((b) => b.holds);
  if (blocker) {
    const design = SETTLED.includes(blocker.status) ? blocker.designHold : null;
    return {
      group: 'stuck',
      waitingOn: wait(
        'issue',
        blocker.key,
        design
          ? 'design approval'
          : awaitsJudge(blocker)
            ? LANDED_BLOCKER
            : blockerAct(blocker.status),
        design
          ? `a live blocks edge from ${blocker.key}, which delivers a design: ${design}; it settles once that revision is approved`
          : awaitsJudge(blocker)
            ? `a live blocks edge from ${blocker.key}, which has landed and is not settled until a judge passes every criterion`
            : `a live blocks edge from ${blocker.key}, not yet settled`,
        blocker.key,
      ),
    };
  }
  const landed = landedWait(status, { merged: input.merged, step: input.step });
  if (landed) {
    return { group: 'queued', waitingOn: wait('judge', landed.who, landed.act, landed.reason) };
  }
  if (status === 'in_progress') {
    return {
      group: 'stuck',
      waitingOn: wait(
        'none',
        'No holder',
        'in progress with no live run',
        'in_progress, but no lease is live and no job or run is in flight',
      ),
    };
  }
  if (status === 'reopen') {
    return {
      group: 'stuck',
      waitingOn: wait(
        'master',
        'Master',
        're-run after reopen',
        'sent back with a reason; a master takes it again',
      ),
    };
  }
  return {
    group: 'queued',
    waitingOn: wait(
      'master',
      'Master',
      status === 'approved' ? 'build next' : 'free slot',
      status === 'approved'
        ? 'the plan checkpoint holds; the next run goes straight to build'
        : 'accepted, nothing blocks it; a master takes it',
    ),
  };
}

const LANDED_BLOCKER = 'landed, waits on a judge';

const awaitsJudge = (e: StandingEdge) => landedWait(e.status, e) !== null;

function blockerAct(status: IssueStatus): string {
  if (status === 'in_progress') return 'running';
  if (status === 'needs_info' || status === 'draft') return 'needs a person';
  if (status === 'on_hold') return 'paused';
  if (status === 'reopen') return 'came back';
  return 'not started';
}

export function deriveIssueStanding(
  input: IssueStandingInput,
  edgeGroups: ReadonlyMap<string, IssueAttentionGroup> = new Map(),
  wave: number | null = null,
): IssueStanding {
  const { group, waitingOn } = turnOf(input);
  const ref = (e: StandingEdge): IssueEdgeRef => ({
    key: e.key,
    title: e.title,
    status: e.status,
    group: edgeGroups.get(e.id) ?? null,
    landed: awaitsJudge(e),
    designHold: SETTLED.includes(e.status) ? (e.designHold ?? null) : null,
  });
  return {
    state: input.status,
    step: input.step,
    stepStartedAt: input.stepStartedAt?.toISOString() ?? null,
    moves: issueMovesFrom(input.status, input.leftStatus),
    tone: toneOf(input.status, input.releaseApproval),
    attentionGroup: group,
    waitingOn,
    criteria: input.criteria,
    requirement: input.requirement,
    module: input.module,
    feedback: [...input.feedback],
    blockedBy: input.blockedBy.filter((b) => b.holds).map(ref),
    blocks: !input.holdsDependents
      ? []
      : input.blocks.filter((b) => !DONE.includes(b.status)).map(ref),
    lease: input.lease,
    inFlight: input.inFlight,
    branch: input.branch,
    headSha: input.headSha,
    owner: input.owner,
    wave: DONE.includes(input.status) ? null : wave,
    touchedAt: input.touchedAt.toISOString(),
  };
}

interface WaveNode {
  id: string;
  /** It holds its dependents (`blocked-by.ts:blockerUnsettledSql`). */
  holds: boolean;
  /** Ids of the issues holding this one back over live `blocks` edges. */
  blockedBy: readonly string[];
}

// cm:why a wave is the layer the master can dispatch from: an open issue with no open blocker is
// wave 0; otherwise one more than its deepest open blocker. A blocker that is settled or done holds
// nothing back. An issue on a cycle (or downstream of one) has no wave: null, never a guess.
export function wavesOf(nodes: readonly WaveNode[]): Map<string, number | null> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, number | null>();
  const visiting = new Set<string>();
  const open = (id: string) => byId.get(id)?.holds === true;
  const visit = (id: string): number | null => {
    if (out.has(id)) return out.get(id) ?? null;
    if (visiting.has(id)) return null;
    visiting.add(id);
    const n = byId.get(id) as WaveNode;
    let wave: number | null = 0;
    for (const b of n.blockedBy) {
      if (!open(b)) continue;
      const w = visit(b);
      if (w === null) {
        wave = null;
        break;
      }
      wave = Math.max(wave, w + 1);
    }
    visiting.delete(id);
    out.set(id, wave);
    return wave;
  };
  for (const n of nodes) if (open(n.id)) visit(n.id);
  return out;
}

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

export interface StepDurationFact {
  runId: string;
  step: string;
  durationSeconds: number;
  costUsd: number;
  at: string;
}

const truncate = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const OUTCOME_KEYS = [
  'outcome',
  'summary',
  'verdict',
  'result',
  'planSummary',
  'rootCauseHypothesis',
];

/** A short line from a free-form handoff payload: the stable fields first, then any string. */
function outcomeLabelOf(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  for (const k of OUTCOME_KEYS) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return truncate(v, 90);
  }
  for (const v of Object.values(payload)) {
    if (typeof v === 'string' && v.trim()) return truncate(v, 90);
  }
  return null;
}

// one entry per job type a handoff or a step duration records, ordered by when it last ran; the
// latest run's attempts are summed and the latest attempt's handoff attached
export function stepOutcomesOf(input: {
  handoffs: readonly IssueStepHandoff[];
  durations: readonly StepDurationFact[];
  activeStep: string | null;
  failedStep: string | null;
}): IssueStepOutcome[] {
  const handoffByStep = new Map<string, IssueStepHandoff>();
  for (const h of input.handoffs) {
    const prev = handoffByStep.get(h.step);
    if (
      !prev ||
      h.updatedAt > prev.updatedAt ||
      (h.updatedAt === prev.updatedAt && h.attempt > prev.attempt)
    )
      handoffByStep.set(h.step, h);
  }
  const runsByStep = new Map<string, Map<string, { seconds: number; cost: number; at: string }>>();
  for (const d of input.durations) {
    const runs = runsByStep.get(d.step) ?? new Map();
    const acc = runs.get(d.runId) ?? { seconds: 0, cost: 0, at: '' };
    acc.seconds += d.durationSeconds;
    acc.cost += d.costUsd;
    if (d.at > acc.at) acc.at = d.at;
    runs.set(d.runId, acc);
    runsByStep.set(d.step, runs);
  }
  const out: IssueStepOutcome[] = [];
  for (const step of new Set([...handoffByStep.keys(), ...runsByStep.keys()])) {
    const handoff = handoffByStep.get(step) ?? null;
    let pick: { seconds: number; cost: number; at: string } | undefined;
    for (const acc of runsByStep.get(step)?.values() ?? [])
      if (!pick || acc.at > pick.at) pick = acc;
    out.push({
      step,
      state: input.failedStep === step ? 'failed' : input.activeStep === step ? 'running' : 'done',
      outcomeLabel: outcomeLabelOf(handoff?.payload ?? null),
      durationSeconds: pick && pick.seconds > 0 ? pick.seconds : null,
      costUsd: pick && pick.cost > 0 ? pick.cost : null,
      handoff,
      ranAt: pick?.at || handoff?.updatedAt || '',
    });
  }
  return out.sort((a, b) => a.ranAt.localeCompare(b.ranAt));
}
