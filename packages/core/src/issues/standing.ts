/**
 * Where an issue stands, derived from what was read and nothing else: the attention group the
 * list puts it under, whom it waits on and for what, its status tone on this project, and the wave
 * it sits in over the open `blocks` edges. Pure, so every rule below is a unit test;
 * `standing-read.ts` gathers the facts.
 */

import type {
  IssueAttentionGroup,
  IssueCriteriaTally,
  IssueEdgeRef,
  IssueLeaseView,
  IssueModuleRef,
  IssueRequirementRef,
  IssueStanding,
  IssueWaitingOn,
} from '@forge/contracts/issue-standing';
import {
  type IssueStatusTone,
  issueStatusToneOn,
  type KernelIssueStatus,
  type WorkStep,
} from '@forge/contracts/issue-vocabulary';

/** Settled blockers release their dependents (`dependency-effects.ts:BLOCKER_SETTLED`). */
const SETTLED: readonly string[] = ['awaiting_release', 'closed'];
const DONE: readonly string[] = ['closed', 'dropped'];

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
  status: KernelIssueStatus;
}

export interface IssueStandingInput {
  status: KernelIssueStatus;
  waitingKind: string | null;
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

const wait = (
  kind: IssueWaitingOn['kind'],
  who: string,
  act: string,
  rule: string,
  ref: string | null = null,
): IssueWaitingOn => ({ kind, who, act, rule, ref });

/** The badge tone of a status on this project (contracts `issueStatusToneOn`). */
export function toneOf(status: KernelIssueStatus, releaseApproval: boolean): IssueStatusTone {
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
// needs_info → a person answers; an open human question at a working status → a person answers it;
// draft → a person takes it on or drops it; awaiting_release → a person approves where the project
// requires it, else queued for the release; a live lease or a job in flight → moving, on the run and
// its step; a live unsettled blocker → stuck on the first; in_progress with no holder → stuck;
// reopen → stuck, the master re-runs it; open or approved → queued for a master slot.
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
  const blocker = input.blockedBy.find(
    (b) => !SETTLED.includes(b.status) && !DONE.includes(b.status),
  );
  if (blocker) {
    return {
      group: 'stuck',
      waitingOn: wait(
        'issue',
        blocker.key,
        blockerAct(blocker.status),
        `a live blocks edge from ${blocker.key}, not yet settled`,
        blocker.key,
      ),
    };
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

function blockerAct(status: KernelIssueStatus): string {
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
  });
  return {
    state: input.status,
    step: input.step,
    stepStartedAt: input.stepStartedAt?.toISOString() ?? null,
    tone: toneOf(input.status, input.releaseApproval),
    attentionGroup: group,
    waitingOn,
    criteria: input.criteria,
    requirement: input.requirement,
    module: input.module,
    feedback: [...input.feedback],
    blockedBy: input.blockedBy
      .filter((b) => !SETTLED.includes(b.status) && !DONE.includes(b.status))
      .map(ref),
    blocks:
      DONE.includes(input.status) || SETTLED.includes(input.status)
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

export interface WaveNode {
  id: string;
  status: string;
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
  const open = (id: string) => {
    const n = byId.get(id);
    return n !== undefined && !SETTLED.includes(n.status) && !DONE.includes(n.status);
  };
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
