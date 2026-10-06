/**
 * Where an issue stands, derived from what was read and nothing else: the attention group the
 * list puts it under, whom it waits on and for what, its status tone on this project, and the wave
 * it sits in over the open `blocks` edges. Pure, so every rule below is a unit test;
 * `standing-read.ts` gathers the facts.
 */

import type { IssueStatus } from '@forge/contracts/issue-machine';
import {
  ISSUE_RESOLVED_STATUSES,
  ISSUE_TERMINAL_STATUSES,
  issueMovesFrom,
  TAKEABLE_STATUSES,
} from '@forge/contracts/issue-machine';
import type {
  IssueAttentionGroup,
  IssueCriteriaTally,
  IssueEdgeRef,
  IssueLeaseView,
  IssueModuleRef,
  IssueRequirementRef,
  IssueStanding,
  IssueWaitingKind,
  IssueWithheld,
  IssueWithheldCode,
} from '@forge/contracts/issue-standing';
import { issueStatusToneOn, type WorkStep } from '@forge/contracts/issue-vocabulary';
import type { WaitingOn } from '@forge/contracts/standing';
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
  /** The move that parked it at `on_hold`: its reason, and whether a run (not a person) made it. */
  park?: { reason: string | null; byAgent: boolean } | null;
  /** A design revision drawn under it that its approver returned and nobody has redrawn. */
  designReturned?: { flow: string; revision: number } | null;
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
  /** The refusal the admissible list withholds it by (`devices/admissible.ts`), first that holds. */
  withheld: IssueWithheld | null;
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
// (`strand-rules.ts:landedWait`); a takeable row the admissible list withholds → stuck, its
// refusal named; in_progress with no holder or reopen → stuck; open or approved → queued for a
// master slot.
type Turn = { group: IssueAttentionGroup; waitingOn: IssueWaitingOn };

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

// An on_hold a run set down waits on what the run named, never on "a person paused it" (HOP run
// 2026-10-05, ISS-1 and ISS-33): a question it asked, the blocker that holds it, or the park's reason.
function agentParkTurn(input: IssueStandingInput): Turn | null {
  const park = input.park;
  if (!park?.byAgent) return null;
  const why = park.reason?.trim() || 'the run named no reason';
  if (input.owesAnswer) {
    const r = forPerson(
      input.viewer,
      'answer a question',
      `a run parked it on_hold and asked a question only a person can answer: ${why}`,
    );
    return { group: 'paused', waitingOn: r.waitingOn };
  }
  const blocker = input.blockedBy.find((b) => b.holds);
  if (blocker) {
    return {
      group: 'paused',
      waitingOn: wait(
        'issue',
        blocker.key,
        blockerAct(blocker.status),
        `a run parked it on_hold behind ${blocker.key}, which still holds it: ${why}`,
        blocker.key,
      ),
    };
  }
  return {
    group: 'paused',
    waitingOn: wait(
      'master',
      'Master',
      `resume once: ${clip(why, 80)}`,
      `a run parked it on_hold: ${why}; the master resumes it once that clears`,
    ),
  };
}

/** A status only a person moves on from: done, paused, a question owed, a draft. */
function personTurn(input: IssueStandingInput): Turn | null {
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
    const parked = agentParkTurn(input);
    if (parked) return parked;
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
  return null;
}

function releaseTurn(input: IssueStandingInput, running: boolean): Turn {
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
      input.viewer,
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

function runningTurn(input: IssueStandingInput): Turn {
  const leased = held(input.lease);
  const step = input.step ? STEP_WORD[input.step] : null;
  const mins = minutesSince(input.stepStartedAt, input.now);
  const act = [step, mins !== null && step ? `${mins} min` : null].filter(Boolean).join(' · ');
  return {
    group: 'moving',
    waitingOn: wait(
      'run',
      leased ? 'Run' : 'Queued run',
      act || (leased ? 'working' : 'starting'),
      leased
        ? `lease held by ${input.lease?.holder ?? 'a run'}`
        : 'a job or run is queued or running on it',
    ),
  };
}

function blockerTurn(blocker: StandingEdge): Turn {
  const design = SETTLED.includes(blocker.status) ? blocker.designHold : null;
  const judged = awaitsJudge(blocker);
  return {
    group: 'stuck',
    waitingOn: wait(
      'issue',
      blocker.key,
      design ? 'design approval' : judged ? LANDED_BLOCKER : blockerAct(blocker.status),
      design
        ? `a live blocks edge from ${blocker.key}, which delivers a design: ${design}; it settles once that revision is approved`
        : judged
          ? `a live blocks edge from ${blocker.key}, which has landed and is not settled until a judge passes every criterion`
          : `a live blocks edge from ${blocker.key}, not yet settled`,
      blocker.key,
    ),
  };
}

const WITHHELD_ACT: Record<IssueWithheldCode, { who: string; act: string }> = {
  POLICY_UNDECLARED: { who: 'A project writer', act: 'declare the policy' },
  POLICY_STATE_UNDECLARED: { who: 'A project writer', act: 'declare its policy state' },
  WORKFLOW_DESIGN_NOT_APPROVED: { who: 'A design approver', act: 'approve the design' },
  CONTRACT_WAIT_UNSETTLED: { who: 'The contract provider', act: 'approve a contract version' },
};

/** A takeable issue no master is handed: stuck, the dispatch door's refusal named as its rule. */
function withheldTurn(withheld: IssueWithheld): Turn {
  const { who, act } = WITHHELD_ACT[withheld.code];
  return {
    group: 'stuck',
    waitingOn: wait(
      'person',
      who,
      act,
      `${withheld.code}: ${withheld.detail} No master is handed it until then.`,
      withheld.code,
    ),
  };
}

/** Nothing holds it and no person owes a move: stuck in progress or after a reopen, else queued. */
function idleTurn(status: IssueStatus): Turn {
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

function turnOf(input: IssueStandingInput): Turn {
  const person = personTurn(input);
  if (person) return person;
  const running = held(input.lease) || input.inFlight;
  if (input.status === 'awaiting_release') return releaseTurn(input, running);
  if (running) return runningTurn(input);
  const blocker = input.blockedBy.find((b) => b.holds);
  if (blocker) return blockerTurn(blocker);
  const returned = input.designReturned;
  if (returned && TAKEABLE_STATUSES.includes(input.status)) {
    return {
      group: 'queued',
      waitingOn: wait(
        'run',
        'Next run',
        `revise design ${returned.flow} · revision ${returned.revision} returned`,
        `its approver returned design ${returned.flow} revision ${returned.revision}, drawn under this issue: what it owes is the revised design, which a run writes and proposes again, not a judgement of what landed`,
        returned.flow,
      ),
    };
  }
  const landed = landedWait(input.status, { merged: input.merged, step: input.step });
  if (landed) {
    return { group: 'queued', waitingOn: wait('judge', landed.who, landed.act, landed.reason) };
  }
  const withheld = withheldOf(input);
  if (withheld) return withheldTurn(withheld);
  return idleTurn(input.status);
}

const LANDED_BLOCKER = 'landed, waits on a judge';

const withheldOf = (input: IssueStandingInput): IssueWithheld | null =>
  TAKEABLE_STATUSES.includes(input.status) ? input.withheld : null;

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
    tone: issueStatusToneOn(input.status, input.releaseApproval),
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
    withheld: withheldOf(input),
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
