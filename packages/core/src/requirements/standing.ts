/**
 * Where a requirement stands, derived from what was read and nothing else: the attention group the
 * list puts it under, whom it waits on and for what, the facts the list's secondary line prints,
 * and each business criterion's coverage by issue verdicts (`standing-coverage.ts`). Pure, so every
 * rule below is a unit test; `standing-read.ts` gathers the facts.
 */

import type { ReleaseLeg } from '@forge/contracts/forecast';
import type { IssueStatusTone } from '@forge/contracts/issue-vocabulary';
import type { Approvals } from '@forge/contracts/person-gates';
import {
  BREAKDOWN_SLA_WORKING_DAYS,
  CHECK_SLA_WORKING_DAYS,
  criteriaCoverageOf,
  draftIssuesToPromote,
  type RequirementAcceptanceDecision,
  type RequirementCoverage,
  type RequirementDelivery,
  type RequirementStanding,
  type RequirementWaitingKind,
  type RequirementWaitingOn,
} from '@forge/contracts/requirements';
import { type Said, type SaidKey, say } from '@forge/contracts/said';
import { type WaitingSays, waitingOn } from '@forge/contracts/standing';
import type { MasterServing } from '@forge/contracts/steward';
import type { VerifiedJudge } from '@forge/contracts/verified-rule';
import type { RequirementStatus } from '../db/schema-requirements.js';
import { withTimes } from '../lib/standing-times.js';
import { stateSinceOf, touchedAt } from './standing-age.js';
import {
  coverageOf,
  type LiveBuildHolds,
  type StandingIssueCriterion,
  type StandingRequirementVerdict,
} from './standing-coverage.js';
import { designTurn, draftTurn, type StandingRevision } from './standing-draft.js';
import {
  reviseForDesignAct,
  type TracedChange,
  updateToApprovedAct,
  updateToApprovedEffect,
} from './standing-follow.js';
import {
  actWait,
  askedTurn,
  nextStepOf,
  ownerWait,
  signerInsteadOfMaster,
  signerWait,
} from './standing-gates.js';
import { proofTurn } from './standing-proof.js';
import { restsOnShipped, shippedTurn } from './standing-shipped.js';
import { breakdownTaskOf, checkTaskOf, replanTasksOf, tasksOf } from './standing-tasks.js';
import { type ParkedWait, type WorkTurn, workTurn } from './standing-work.js';

export type {
  LiveBuildHolds,
  StandingIssueCriterion,
  StandingRequirementVerdict,
  StandingVerdict,
} from './standing-coverage.js';

interface StandingCriterion {
  id: string;
  code: string;
  body: string;
  sinceRevision: number;
  retiredRevision: number | null;
}

export interface StandingIssue {
  id: string;
  displayId: string;
  title: string;
  status: string;
  /** The status's tone on this project; awaiting_release is amber only where a release needs approval. */
  tone: IssueStatusTone;
  updatedAt: Date;
  /** When it last moved to closed; null while it is not closed. */
  closedAt: Date | null;
  /** When it first moved past draft and open; null while it has not, or where the reader does not say. */
  startedAt?: Date | null;
  /** Its plan was written against another revision than the current one. */
  changedSincePlan: boolean;
  /** Where it is parked (`PARK_STATUSES`), what it waits on by its own standing; null otherwise. */
  parkedOn: ParkedWait | null;
}

export interface StandingInput {
  status: RequirementStatus;
  owner: RequirementStanding['owner'];
  /**
   * Null for a reader with no person behind it; nothing then reads as theirs. `canAdmit` is
   * what the admit gate asks (issues.admit where enforced, project.write where not), which the
   * promote of a draft needs (REQ-76 / ISS-640).
   */
  viewer: {
    userId: string;
    canSignOff: boolean;
    canAdmit: boolean;
    /** suggestions.approve: what a breakdown's accept asks where its switch is on. */
    canApproveBreakdown?: boolean;
  } | null;
  /**
   * The project document's `approvals` (`@forge/contracts/person-gates`): which steps ask a
   * person. Absent or null reads every switch off, the default.
   */
  approvals?: Approvals | null;
  revisions: readonly StandingRevision[];
  currentRevision: number | null;
  criteria: readonly StandingCriterion[];
  issues: readonly StandingIssue[];
  issueCriteria: readonly StandingIssueCriterion[];
  /** Its criteria's verdicts recorded at the requirement itself (ISS-588); absent reads as none. */
  requirementVerdicts?: readonly StandingRequirementVerdict[];
  /** Kinds of the suggestions still `proposed` on this requirement. */
  openSuggestionKinds: readonly string[];
  /** Per BC code, why the newest accepted breakdown naming it left it uncovered. */
  uncovered?: ReadonlyMap<string, string>;
  /** What the live build holds of the verdict commits; null or absent where it was not read. */
  liveBuild?: LiveBuildHolds | null;
  /** Linked designs the latest baseline leaves unpinned or pins below their approved revision. */
  stalePins: readonly { flow: string; title: string; pinned: number | null; approved: number }[];
  staleContractPins: readonly { contract: string; pinned: string | null; current: string }[];
  /**
   * The nodes live criteria trace that a stale design pin's approval removed or renamed
   * (`follow-reads.ts:followReadsOf`); absent or empty where none did, and a signer re-pins it.
   */
  tracedChanges?: readonly TracedChange[];
  /** An open steward decision on this stuck draft or its draft revision (REQ-48 BC-5, `steward/door-decide.ts`). */
  stewardAsked?: boolean;
  /** Whether any other open question asked of it waits on a person (REQ-68 BC-9). */
  questionAsked?: boolean;
  /** Linked designs holding no approved revision, which an agree refuses (REQUIREMENT_DESIGN_UNAPPROVED). */
  unapprovedDesigns: readonly { flow: string; title: string; designStatus: string | null }[];
  feedback: { open: number; untriaged: readonly string[] };
  /** Who judges an issue's criteria: its own runs (`self`) or a judge apart from them (`independent`), the policy's `qa`; null where no policy is declared. */
  judge: VerifiedJudge | null;
  /**
   * Whether a runner is bound to the project, so a master can act (FB-77). False reads a wait on
   * "Master" as the signer's, naming why; absent reads as bound.
   */
  runnerBound?: boolean;
  /** When the current revision was first agreed: its first baseline. */
  agreedAt: Date | null;
  /**
   * What follows a landing on the project (`forecast/release.ts:releaseLegFor`), read where every live
   * issue not yet shipped awaits release (`standing-work.ts:awaitsReleaseOnly`); null elsewhere.
   */
  release: ReleaseLeg | null;
  updatedAt: Date;
  /**
   * When its status last moved (its kernel transitions), else when it was filed. Never `updatedAt`:
   * a placement or short-name edit moves that and must not restart AGE (live dev.227).
   */
  statusSince: Date;
  /** Whether a live master serves the project (`masters/read.ts:masterServingOf`), so a wait on it can read stuck. */
  master: MasterServing;
  /** Where its accept waived the acceptance checklist's blocking items, what and why; else null or absent. */
  acceptedByDecision?: RequirementAcceptanceDecision | null;
  now: Date;
}

/** An issue as the delivery counts and coverage read it: its wait is the turn's, not the proof's. */
export type ProofIssue = Omit<StandingIssue, 'parkedOn'>;

/** What the delivery counts and coverage read, and nothing else. */
type ProofInput<I extends ProofIssue = ProofIssue> = Pick<
  StandingInput,
  | 'status'
  | 'criteria'
  | 'issueCriteria'
  | 'requirementVerdicts'
  | 'uncovered'
  | 'liveBuild'
  | 'judge'
> & { issues: readonly I[] };

const SIGNER = say('standing.who.baOrOwner');
const ADMITTER = say('standing.who.signerAdmitter');

const wait = (
  kind: RequirementWaitingKind,
  who: Said,
  act: Said,
  rule: Said,
  more: Partial<Pick<WaitingSays, 'effect'>> & { dueAt?: string | null } = {},
): RequirementWaitingOn =>
  waitingOn(
    kind,
    { who, act, rule, ...(more.effect ? { effect: more.effect } : {}) },
    { dueAt: more.dueAt ?? null },
  );

const YOU = say('standing.who.you');
const MASTER = say('standing.who.master');
const NONE = say('standing.who.dash');
const BA = say('requirements.who.ba');

type Turn = WorkTurn;

function feedbackTurn(input: StandingInput): Turn | null {
  const untriaged = input.feedback.untriaged;
  if (untriaged.length === 0) return null;
  const [one] = untriaged;
  return signerWait(
    input.viewer,
    untriaged.length === 1 && one !== undefined
      ? say('standing.act.triage', { what: one })
      : say('standing.act.triageMany', { n: untriaged.length }),
    say('requirements.rule.feedbackWaits', { keys: untriaged.join(', ') }),
  );
}

// Whose turn it is, first rule wins: 1. dropped, refused or deferred → nobody (ISS-85, REQ-65 BC-6:
// keeping a refused request is a person's choice, never owed), accepted →
// done unless feedback waits on triage; 2. a proposed revision → a signer; 3. a draft revision →
// its author, unless 2b. the steward asked a decision on the stuck draft → a signer answers it
// (REQ-48 BC-5); 4. a draft requirement → a signer agrees it; 4b. untriaged feedback → a
// signer triages it (ISS-79); 5. a design approved past the pin → a signer re-pins it (REQ-41 BC-10,
// ISS-86; nothing re-pins by itself), unless the approval removed
// or renamed a step a live criterion traces → the assistant revises those criteria, and once a
// revision is suggested a signer reviews it; 6. every
// issue closed and every BC proven → the BA's check task, a BC unproven → whoever owes its proof
// (`proofTurn`); 7. an open breakdown → a signer; 8. an issue planned on an earlier revision or baseline → the master
// re-plans it (its re-plan tasks); 9a. no issue and a verdict recorded at the requirement → it rests on
// its shipped capability (`standing-shipped.ts:shippedTurn`, ISS-588): its accept, its judge or, for a
// failing criterion, the master; 9. no issue → the master breaks it down; 10. only drafts → a signer who can
// admit promotes them (only they are asked: question 3b8292dc);
// 11. else whom the work waits on (`standing-work.ts:workTurn`): a parked issue's own wait, the release
// cut once every issue has landed, the issues while one runs, else the master. Then
// `lib/standing-times.ts:withTimes` reads the stuck rule over the turn: no owner, nobody serving its
// wait, only draft issues, an issue stuck by its own standing, or the wait falling overdue.
function turnOf(
  input: StandingInput,
  live: readonly StandingIssue[],
  coverage: readonly RequirementCoverage[],
): Turn {
  const { status, viewer } = input;
  if (status === 'accepted' || status === 'dropped' || status === 'refused') {
    const triage = status === 'accepted' ? feedbackTurn(input) : null;
    return (
      triage ?? {
        group: 'done',
        waitingOn: wait(
          'none',
          NONE,
          say('standing.act.none'),
          say('requirements.rule.ended', { status }),
        ),
      }
    );
  }
  if (status === 'deferred') {
    return {
      group: 'deferred',
      waitingOn: wait('none', NONE, say('standing.act.none'), say('requirements.rule.deferred')),
    };
  }
  const proposed = input.revisions.find((r) => r.state === 'proposed');
  if (proposed) {
    return actWait(
      input,
      'revisions',
      say('standing.act.acceptR', { r: proposed.revision }),
      say('requirements.rule.proposed'),
    );
  }
  const draft = input.revisions.find((r) => r.state === 'draft');
  const asked = askedTurn(input, Boolean(draft) || status === 'draft');
  if (asked) return asked;
  if (draft) return draftTurn(draft, viewer);
  if (status === 'draft') {
    const head = input.currentRevision;
    // an agree pins a current head (`rules.ts:agreeRefusals`), so with none there is nothing to
    // agree: its owner writes a revision, own work and never a decision (REQ-48 BC-11)
    if (head === null) {
      return ownerWait(
        input,
        say('standing.act.writeRevision'),
        say('requirements.rule.noRevision'),
      );
    }
    const designs = designTurn(input.unapprovedDesigns, head);
    if (designs) return designs;
    return actWait(
      input,
      'agree',
      say('standing.act.agreeR', { r: head }),
      say('requirements.rule.unagreed'),
    );
  }
  const triage = feedbackTurn(input);
  if (triage) return triage;
  const traced = input.tracedChanges ?? [];
  if (traced.length > 0) {
    if (input.openSuggestionKinds.includes('revision_diff')) {
      return signerWait(
        viewer,
        say('standing.act.reviewSuggestedRevision'),
        say('requirements.rule.revisionSuggested'),
      );
    }
    return {
      group: 'waiting',
      waitingOn: wait(
        'agent',
        MASTER,
        reviseForDesignAct(traced),
        say('requirements.rule.tracedStepChanged'),
      ),
    };
  }
  if (input.stalePins.length > 0 || input.staleContractPins.length > 0) {
    const act = updateToApprovedAct(input.stalePins, input.staleContractPins);
    const rule = say('requirements.rule.pinBehind');
    const effect = updateToApprovedEffect(input.stalePins, input.staleContractPins);
    if (viewer?.canSignOff) {
      return { group: 'needs_you', waitingOn: wait('you', YOU, act, rule, { effect }) };
    }
    const owner = input.owner?.kind === 'human' ? input.owner.name : null;
    return {
      group: 'waiting',
      waitingOn: wait(
        'person',
        owner ? say('standing.who.named', { name: owner }) : SIGNER,
        act,
        rule,
        { effect },
      ),
    };
  }
  const move = moveTurn(input, live, coverage);
  if (move) return move;
  const check = checkTaskOf(input, live);
  if (check) {
    const date = check.dueAt.slice(0, 10);
    const act = say('standing.act.check', {
      codes: coverage.map((c) => c.code).join(', '),
      when: say(check.overdue ? 'standing.overdueSince' : 'standing.due', { date }),
    });
    const rule = say('requirements.rule.check', {
      r: check.revision,
      date,
      days: CHECK_SLA_WORKING_DAYS,
      overdue: check.overdue ? say('requirements.rule.overdue') : null,
    });
    return actWait(input, 'accept', act, rule, { dueAt: check.dueAt, holder: BA });
  }
  const proof = proofTurn(input.judge, live, coverage);
  if (proof) return proof;
  if (input.openSuggestionKinds.includes('breakdown')) {
    return actWait(
      input,
      'breakdown',
      say('standing.act.reviewBreakdown'),
      say('requirements.rule.breakdownWaits'),
    );
  }
  const replan = replanTasksOf(input, live);
  if (replan.length > 0) {
    return {
      group: 'waiting',
      waitingOn: wait(
        'agent',
        MASTER,
        say('standing.act.replan', { keys: replan.map((t) => t.displayId).join(', ') }),
        input.currentRevision === null
          ? say('requirements.rule.replanUnknown')
          : say('requirements.rule.replan', { r: input.currentRevision }),
      ),
    };
  }
  if (restsOnShipped(live, coverage)) {
    return shippedTurn(input, coverage, breakdownTaskOf(input, live, coverage)?.dueAt ?? null);
  }
  if (live.length === 0) {
    const task = breakdownTaskOf(input, live, coverage);
    return {
      group: 'waiting',
      waitingOn: wait(
        'agent',
        MASTER,
        task
          ? say('standing.act.breakDownBy', {
              when: say(task.overdue ? 'standing.overdueSince' : 'standing.due', {
                date: task.dueAt.slice(0, 10),
              }),
            })
          : say('standing.act.breakDown'),
        task
          ? say('requirements.rule.breakdownDue', {
              date: task.dueAt.slice(0, 10),
              days: BREAKDOWN_SLA_WORKING_DAYS,
            })
          : say('requirements.rule.noIssue'),
        { dueAt: task?.dueAt ?? null },
      ),
    };
  }
  const drafts = draftIssuesToPromote(status, live);
  if (drafts.length === live.length) {
    const act =
      drafts.length === 1
        ? say('standing.act.promoteDraft')
        : say('standing.act.promoteDrafts', { n: drafts.length });
    const rule = say('requirements.rule.onlyDrafts');
    const draftCarrier = drafts[0]?.displayId ?? null;
    return viewer?.canAdmit
      ? { group: 'needs_you', waitingOn: wait('you', YOU, act, rule), draftCarrier }
      : { group: 'waiting', waitingOn: wait('person', ADMITTER, act, rule), draftCarrier };
  }
  return workTurn(live, input.release);
}

// workflow requirement-to-delivery step `rollup`: what the live issues and the coverage count. Which
// step the requirement stands at is its stored status alone (REQ-74 BC-8): nothing here reads one
function deliveryOf(
  live: readonly ProofIssue[],
  coverage: readonly RequirementCoverage[],
): RequirementDelivery {
  return {
    liveIssues: live.length,
    startedIssues: live.filter((i) => i.status !== 'draft' && i.status !== 'open').length,
    closedIssues: live.filter((i) => i.status === 'closed').length,
    criteriaCoverage: criteriaCoverageOf(coverage),
  };
}

/**
 * The explicit move (REQ-74 BC-8) a requirement waits on once its live issues all closed and every
 * live criterion passes: into delivery, then delivered. Asked of whoever may make it, never made here.
 */
const MOVE_ASKED: Partial<Record<RequirementStatus, readonly [SaidKey, SaidKey]>> = {
  agreed: ['standing.act.startDelivery', 'requirements.rule.startDelivery'],
  in_delivery: ['standing.act.markDelivered', 'requirements.rule.markDelivered'],
};

function moveTurn(
  input: StandingInput,
  live: readonly StandingIssue[],
  coverage: readonly RequirementCoverage[],
): Turn | null {
  const done =
    live.length > 0 &&
    live.every((i) => i.status === 'closed') &&
    coverage.length > 0 &&
    coverage.every((c) => c.verdict === 'passing');
  const move = done ? MOVE_ASKED[input.status] : undefined;
  return move ? actWait(input, 'accept', say(move[0]), say(move[1])) : null;
}

/** The live issues, their counts and BC coverage at `revision`: the one computation the standing, the moves and the accept read. */
export function deliveryAt<I extends ProofIssue>(input: ProofInput<I>, revision: number | null) {
  const live = input.issues.filter((i) => i.status !== 'dropped');
  const coverage = coverageOf(input, revision);
  return { live, coverage, delivery: deliveryOf(live, coverage) };
}

export function deriveStanding(raw: StandingInput): RequirementStanding {
  const shownRevision = raw.currentRevision ?? raw.revisions[0]?.revision ?? null;
  const { live, coverage, delivery } = deliveryAt(raw, shownRevision);
  const input = raw;
  const touched = touchedAt(input);
  const turn = turnOf(input, live, coverage);
  let { group, waitingOn } = turn;
  if (input.runnerBound === false && waitingOn.says.who.key === MASTER.key) {
    ({ group, waitingOn } = signerInsteadOfMaster(input.viewer, waitingOn));
  }
  const ownerless = input.owner === null && !['needs_you', 'done', 'deferred'].includes(group);
  if (ownerless) {
    waitingOn = wait(
      'none',
      say('requirements.who.noOwner'),
      say('requirements.act.assignOwner'),
      say('requirements.rule.noOwner'),
    );
  }
  const timed = withTimes(
    { group, waitingOn },
    {
      since: turn.since ?? input.statusSince,
      master: input.master,
      ownerless,
      draftCarrier: turn.draftCarrier ?? null,
      carried: turn.carried ?? null,
      now: input.now,
    },
    'waiting',
  );
  const state = input.status;
  return {
    state,
    // a requirement resting on its shipped capability has no issue to move it into delivery
    // (REQUIREMENT_NO_LIVE_ISSUE): its next step is its accept
    next:
      state === 'agreed' && restsOnShipped(live, coverage)
        ? 'accepted'
        : nextStepOf(state, input.agreedAt),
    delivery,
    attentionGroup: timed.group,
    waitingOn,
    times: timed.times,
    facts: {
      ...delivery.criteriaCoverage,
      issuesRunning: live.filter((i) => i.status === 'in_progress').length,
      issuesTotal: live.length,
      proposedRevision: input.revisions.find((r) => r.state === 'proposed')?.revision ?? null,
      draftRevision: input.revisions.find((r) => r.state === 'draft')?.revision ?? null,
      stalePins: [...input.stalePins],
      staleContractPins: [...input.staleContractPins],
      unapprovedDesigns: [...input.unapprovedDesigns],
      feedbackOpen: input.feedback.open,
      feedbackUntriaged: input.feedback.untriaged.length,
    },
    tasks: tasksOf(input, live, coverage),
    shownRevision,
    coverage,
    owner: input.owner,
    touchedAt: touched.toISOString(),
    stateSince: stateSinceOf(input).toISOString(),
    acceptedByDecision: input.acceptedByDecision ?? null,
  };
}
