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
} from '@forge/contracts/issue-standing';
import { issueStatusToneOn, type WorkStep } from '@forge/contracts/issue-vocabulary';
import type { ParkAnsweredView } from '@forge/contracts/park';
import type { ReleaseHoldView } from '@forge/contracts/releases';
import { type Said, say, verbatim } from '@forge/contracts/said';
import { holdersWho, nobodyHoldsAct, type WaitingOn } from '@forge/contracts/standing';
import type { MasterServing } from '@forge/contracts/steward';
import { withTimes } from '../lib/standing-times.js';
import { answeredWait } from './answered-wait.js';
import { releaseHoldWords } from './release-hold-words.js';
import { awaitsJudge, blockerAct, blockerTurn, withheldTurn } from './standing-held.js';
import { releaseTurn } from './standing-release.js';
import { wait } from './standing-wait.js';
import { landedWait } from './strand-rules.js';

/** Settled blockers release their dependents (`dependency-effects.ts:BLOCKER_SETTLED_STATUSES`). */
const SETTLED: readonly string[] = ISSUE_RESOLVED_STATUSES;
const DONE: readonly string[] = ISSUE_TERMINAL_STATUSES;

const NEEDS_INFO_ACT: Record<string, Said> = {
  needs_answer: say('issues.standing.act.answer'),
  needs_decision: say('issues.standing.act.decide'),
  needs_resource: say('issues.standing.act.supply'),
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
  /** The merge mark names design artifacts alone (`design-delivery.ts:designOnlyMarkSql`). */
  designOnly: boolean;
  /** This issue holds its dependents (`blocked-by.ts:blockerUnsettledSql`). */
  holdsDependents: boolean;
  waitingKind: string | null;
  merged: boolean;
  step: WorkStep | null;
  stepStartedAt: Date | null;
  lease: IssueLeaseView | null;
  inFlight: boolean;
  /** A run session holds it through the fleet lease (`issue-lease.ts:issueRunLiveSql`). */
  runLive: boolean;
  /** An open `human` question on it (`questions/issue-coupling.ts:holdsOpenHumanQuestion`). */
  owesAnswer: boolean;
  /** At `needs_info`: the question answered since the park, with what it said and did (ISS-258). */
  answered?: Pick<ParkAnsweredView, 'hold' | 'resume'> | null;
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
  feedback: readonly { key: string; dropped: boolean }[];
  branch: string | null;
  headSha: string | null;
  owner: IssueStanding['owner'];
  touchedAt: Date;
  /** Whether the project requires a person to approve a release (`release.approval.required`). */
  releaseApproval: boolean;
  /** It carries a release note; at the gate, one without is refused `RELEASE_RECORD_MISSING`. */
  releaseNoted: boolean;
  /** A merged change request delivering it that no merged mark records (ISS-774), else null. */
  owedMark?: { number: number; commit: string } | null;
  /** The automatic release's standing hold on it (`release-batch/hold.ts:releaseHoldsOf`), else null. */
  releaseHold: ReleaseHoldView | null;
  /** Null for a reader with no person behind it; nothing then reads as theirs. */
  viewer: { userId: string; canWrite: boolean } | null;
  /** The names of the people holding project.write, whom a person's turn names (FB-104). */
  writers: readonly string[];
  /** The names of the people holding project.admin, whom an act only an admin takes names. */
  admins: readonly string[];
  /** The refusal the admissible list withholds it by (`devices/admissible.ts`), first that holds. */
  withheld: IssueWithheld | null;
  /** When it came to its status: its newest kernel move there, else its creation (never a write). */
  statusSince: Date;
  /** Whether a live master serves the project (`masters/read.ts:masterServingOf`). */
  master: MasterServing;
  now: Date;
}

export type IssueWaitingOn = WaitingOn<IssueWaitingKind>;

const YOU = say('standing.who.you');
const MASTER = say('standing.who.master');
const NOBODY = say('standing.who.nobody');
const named = (name: string) => say('standing.who.named', { name });

const minutesSince = (from: Date | null, now: Date) =>
  from ? Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000)) : null;

type People = Pick<IssueStandingInput, 'viewer' | 'writers'>;

/** Whose a person's act is: the viewer where they can write, else the project's writers by name,
 *  else nobody — said with where write is granted, never "A project writer" naming no one (FB-104). */
function forPerson(
  people: People,
  act: Said,
  rule: Said,
): { group: IssueAttentionGroup; waitingOn: IssueWaitingOn } {
  if (people.viewer?.canWrite)
    return { group: 'needs_you', waitingOn: wait('you', YOU, act, rule) };
  if (people.writers.length === 0) {
    return {
      group: 'stuck',
      waitingOn: wait(
        'none',
        NOBODY,
        nobodyHoldsAct(act, 'project.write'),
        say('issues.rule.noWriter', { rule, perm: 'project.write' }),
      ),
    };
  }
  return {
    group: 'needs_you',
    waitingOn: wait('person', holdersWho(people.writers), act, rule),
  };
}

const held = (lease: IssueLeaseView | null) =>
  lease !== null && (lease.verdict === 'live' || lease.verdict === 'shared');

// whose turn it is, first rule that holds wins: closed or dropped → done; on_hold → paused;
// needs_info or an open human question → a person answers (the steward's decision on a stuck draft
// among them); draft → its live blocker first, else a person takes it on or drops it; awaiting_release → the hold the
// automatic release recorded where one stands (ISS-577), else the master while a criterion no longer passes or no note is written, else
// a person approves where the project requires it, else queued for the release; a live lease or a job in flight →
// moving; a live unsettled blocker → stuck on the first, worded as waiting on its judge where its
// change landed; a landed row nothing holds → queued for its judge
// (`strand-rules.ts:landedWait`); a takeable row the admissible list withholds → stuck, its
// refusal named; in_progress with no holder → stuck; reopen, open or approved → queued for a
// master slot. Then `lib/standing-times.ts:withTimes` reads the stuck rule over the turn.
export type Turn = { group: IssueAttentionGroup; waitingOn: IssueWaitingOn };

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

// An on_hold a run set down waits on what the run named, never on "a person paused it" (HOP run
// 2026-10-05, ISS-1 and ISS-33): a question it asked, the blocker that holds it, or the park's reason.
function agentParkTurn(input: IssueStandingInput): Turn | null {
  const park = input.park;
  if (!park?.byAgent) return null;
  const reason = park.reason?.trim();
  const why = reason ? verbatim(reason) : say('issues.rule.noReason');
  if (input.owesAnswer) {
    const r = forPerson(
      input,
      say('issues.standing.act.answer'),
      say('issues.rule.parkedAsked', { why }),
    );
    return { group: r.group, waitingOn: r.waitingOn };
  }
  const blocker = input.blockedBy.find((b) => b.holds);
  if (blocker) {
    return {
      group: 'paused',
      waitingOn: wait(
        'issue',
        named(blocker.key),
        blockerAct(blocker.status),
        say('issues.rule.parkedBehind', { key: blocker.key, why }),
        blocker.key,
      ),
    };
  }
  return {
    group: 'paused',
    waitingOn: wait(
      'master',
      MASTER,
      say('issues.standing.act.resumeOnce', { why: reason ? verbatim(clip(reason, 80)) : why }),
      say('issues.rule.parked', { why }),
    ),
  };
}

/** A park whose question was answered and that did not move: what it still waits on, never an answer owed. */
function answeredParkTurn(
  answered: Pick<ParkAnsweredView, 'hold' | 'resume'>,
  people: People,
): Turn {
  const w = answeredWait(answered);
  const rule = say('issues.rule.answered', { reason: w.reason, who: w.who });
  if (w.on === 'person') return forPerson(people, w.act, rule);
  if (w.on === 'issue' && w.ref) {
    return { group: 'stuck', waitingOn: wait('issue', named(w.ref), w.act, rule, w.ref) };
  }
  if (w.on === 'run') {
    return { group: 'moving', waitingOn: wait('run', say('issues.standing.who.run'), w.act, rule) };
  }
  return { group: 'queued', waitingOn: wait('master', MASTER, w.act, rule) };
}

/** A status only a person moves on from: done, paused, a question owed, a draft. */
function personTurn(input: IssueStandingInput): Turn | null {
  const { status } = input;
  if (status === 'closed' || status === 'dropped') {
    return {
      group: 'done',
      waitingOn: wait(
        'none',
        NOBODY,
        say(status === 'closed' ? 'issues.standing.act.shipped' : 'issues.standing.act.dropped'),
        say('issues.rule.ended', { status }),
      ),
    };
  }
  if (status === 'on_hold') {
    const parked = agentParkTurn(input);
    if (parked) return parked;
    const r = forPerson(input, say('issues.standing.act.resume'), say('issues.rule.personPaused'));
    return { group: 'paused', waitingOn: r.waitingOn };
  }
  if (status === 'needs_info' && !input.owesAnswer && input.answered) {
    return answeredParkTurn(input.answered, input);
  }
  if (status === 'needs_info') {
    return forPerson(
      input,
      NEEDS_INFO_ACT[input.waitingKind ?? ''] ?? say('issues.standing.act.answer'),
      say('issues.rule.needsInfo'),
    );
  }
  if (input.owesAnswer) {
    return forPerson(input, say('issues.standing.act.answer'), say('issues.rule.runAsked'));
  }
  if (status === 'draft') {
    // a draft behind a live blocker waits on that blocker first, not on a person's Needs you
    const blocker = input.blockedBy.find((b) => b.holds);
    if (blocker) return blockerTurn(blocker);
    return forPerson(input, say('issues.standing.act.takeOnOrDrop'), say('issues.rule.draft'));
  }
  return null;
}

/**
 * A row the automatic release recorded a hold on waits on what the hold says, never on "the next
 * release" (ISS-577): a person's hold reads stuck on that person, the release's own queued on it.
 * Who clears it and the act are the hold's own words (`release-hold-words.ts`, ISS-684): a runner
 * that is not online is its owner's to bring back, never "Release · a runner to come online".
 */
function releaseHeldTurn(hold: ReleaseHoldView, people: People): Turn {
  const { act, actor } = releaseHoldWords(hold);
  const rule = say('issues.rule.releaseHeld', { code: hold.code, reason: hold.reason });
  const group = hold.owes === 'human' ? 'stuck' : 'queued';
  if (actor === 'release')
    return { group, waitingOn: wait('release', say('issues.standing.who.release'), act, rule) };
  if (actor === 'runnerOwner')
    return { group, waitingOn: wait('person', say('standing.who.runnerOwner'), act, rule) };
  if (actor === 'admin')
    return { group, waitingOn: wait('person', say('standing.who.projectAdmin'), act, rule) };
  if (actor === 'agent') return { group: 'queued', waitingOn: wait('master', MASTER, act, rule) };
  return { group, waitingOn: forPerson(people, act, rule).waitingOn };
}

function runningTurn(input: IssueStandingInput): Turn {
  const leased = held(input.lease) || input.runLive;
  const step = input.step;
  const mins = minutesSince(input.stepStartedAt, input.now);
  const act: Said = step
    ? mins !== null
      ? say('issues.standing.act.stepFor', { step, n: mins })
      : say('issues.standing.act.step', { step })
    : say(leased ? 'issues.standing.act.working' : 'standing.act.starting');
  const holder = input.lease?.holder ?? null;
  return {
    group: 'moving',
    waitingOn: wait(
      'run',
      say(leased ? 'issues.standing.who.run' : 'issues.standing.who.queuedRun'),
      act,
      leased
        ? holder !== null
          ? say('issues.rule.leaseHeld', { holder })
          : say('issues.rule.leaseHeldSession')
        : say('issues.rule.queued'),
    ),
  };
}

/** Nothing holds it and no person owes a move: stuck in progress with no holder, else queued for the
 *  master, which `withTimes` reads stuck where no master serves or the take falls overdue. */
function idleTurn(status: IssueStatus): Turn {
  if (status === 'in_progress') {
    return {
      group: 'stuck',
      waitingOn: wait(
        'none',
        say('issues.standing.who.noHolder'),
        say('issues.standing.act.noLiveRun'),
        say('issues.rule.noHolder'),
      ),
    };
  }
  if (status === 'reopen') {
    return {
      group: 'queued',
      waitingOn: wait(
        'master',
        MASTER,
        say('issues.standing.act.rerun'),
        say('issues.rule.reopen'),
      ),
    };
  }
  return {
    group: 'queued',
    waitingOn: wait(
      'master',
      MASTER,
      say(status === 'approved' ? 'issues.standing.act.buildNext' : 'issues.standing.act.dispatch'),
      say(status === 'approved' ? 'issues.rule.approved' : 'issues.rule.admitted'),
    ),
  };
}

/**
 * A change request delivering it merged and no mark records it (ISS-774): Forge does not write the
 * mark from the host's report, so the act is owed to whoever works it, its run where one holds it,
 * else the master.
 */
function owedMarkTurn(owed: { number: number; commit: string }, running: boolean): Turn {
  const act = say('issues.standing.act.markMerged', {
    n: owed.number,
    sha: owed.commit.slice(0, 9),
  });
  const rule = say('issues.rule.markOwed', { n: owed.number, sha: owed.commit });
  return running
    ? { group: 'moving', waitingOn: wait('run', say('issues.standing.who.run'), act, rule) }
    : { group: 'queued', waitingOn: wait('master', MASTER, act, rule) };
}

function turnOf(input: IssueStandingInput): Turn {
  const person = personTurn(input);
  if (person) return person;
  const running = held(input.lease) || input.inFlight;
  if (input.owedMark) return owedMarkTurn(input.owedMark, running);
  if (input.status === 'awaiting_release') {
    const hold = releaseHoldOf(input);
    return hold ? releaseHeldTurn(hold, input) : releaseTurn(input, running);
  }
  if (running) return runningTurn(input);
  const blocker = input.blockedBy.find((b) => b.holds);
  if (blocker) return blockerTurn(blocker);
  const returned = input.designReturned;
  if (returned && TAKEABLE_STATUSES.includes(input.status)) {
    return {
      group: 'queued',
      waitingOn: wait(
        'run',
        say('issues.standing.who.nextRun'),
        say('issues.standing.act.reviseDesign', { flow: returned.flow, r: returned.revision }),
        say('issues.rule.designReturned', { flow: returned.flow, r: returned.revision }),
        returned.flow,
      ),
    };
  }
  const landed = landedWait(input.status, { merged: input.merged, step: input.step });
  if (landed) {
    return {
      group: 'queued',
      waitingOn: wait('judge', landed.says.who, landed.says.act, landed.says.rule),
    };
  }
  const withheld = withheldOf(input);
  if (withheld) return withheldTurn(withheld, input.admins);
  return idleTurn(input.status);
}

const withheldOf = (input: IssueStandingInput): IssueWithheld | null =>
  TAKEABLE_STATUSES.includes(input.status) ? input.withheld : null;

const releaseHoldOf = (input: IssueStandingInput): ReleaseHoldView | null =>
  input.status === 'awaiting_release' ? input.releaseHold : null;

export function deriveIssueStanding(
  input: IssueStandingInput,
  edgeGroups: ReadonlyMap<string, IssueAttentionGroup> = new Map(),
  wave: number | null = null,
): IssueStanding {
  const turn = turnOf(input);
  const { waitingOn } = turn;
  const { group, times } = withTimes(
    turn,
    { since: sinceOf(input), master: input.master, now: input.now },
    'queued',
  );
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
    moves: issueMovesFrom(input.status, input.leftStatus, input.designOnly),
    tone: issueStatusToneOn(input.status, input.releaseApproval),
    attentionGroup: group,
    waitingOn,
    criteria: input.criteria,
    requirement: input.requirement,
    module: input.module,
    feedback: input.feedback.map((f) => f.key),
    feedbackDropped: input.feedback.filter((f) => f.dropped).map((f) => f.key),
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
    releaseHold: releaseHoldOf(input),
    times,
  };
}

/** When the wait began: the step a run is on, else the move into its status. */
const sinceOf = (input: IssueStandingInput): Date =>
  input.stepStartedAt && input.stepStartedAt > input.statusSince
    ? input.stepStartedAt
    : input.statusSince;
