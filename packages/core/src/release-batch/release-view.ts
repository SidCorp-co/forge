import { isDecisionActOn } from '@forge/contracts/needs-you-decisions';
import type {
  ReleaseAttemptStage,
  ReleaseAttentionGroup,
  ReleaseCriteriaTotals,
  ReleaseCriterionView,
  ReleaseGateOwner,
  ReleasePerson,
  ReleaseProof,
  ReleaseRequirementView,
  ReleaseState,
  ReleaseWaitingKind,
} from '@forge/contracts/releases';
import { type BcVerdict, criteriaCoverageOf, isAgreedStatus } from '@forge/contracts/requirements';
import { type Said, say } from '@forge/contracts/said';
import {
  holdersWho,
  nobodyHoldsAct,
  nobodyWaits,
  type Standing,
  type WaitingSays,
  waitingOn,
} from '@forge/contracts/standing';
import type { VerifiedJudge } from '@forge/contracts/verified-rule';
import { agrees } from '../lib/plural.js';

export interface ViewerFacts {
  userId: string;
  agency: 'human' | 'agent';
  isAdmin: boolean;
  /** Holds releases.approve (`permissions/can.ts:holds`). */
  mayApprove: boolean;
}

interface TurnFacts {
  state: ReleaseState;
  version: string;
  /** The project and run, which the route a master asks approval with names (ISS-591). */
  projectId: string;
  runId: string | null;
  /** The requests a change-request release merges, in order; null on a release that deploys (REQ-71). */
  merges: number | null;
  /** The branch a recorded landing put it on, off production's branch; null on any other release. */
  landedOn: string | null;
  /** `release.approval.required` of the project document. */
  required: boolean;
  approval: {
    decision: 'approved' | 'returned' | null;
    requestedBy: ReleasePerson;
    reason: string | null;
  } | null;
  approvers: readonly ReleasePerson[];
  /** Who holds project.admin, by name: whom a cut names. */
  admins: readonly string[];
  viewer: ViewerFacts | null;
  /** The blockers, in the order the door refuses in, each with whoever owes its act. */
  gates: readonly { code: string; owner: ReleaseGateOwner }[];
  inFlight: ReleaseAttemptStage | null;
  /**
   * Where the project names its testing environment (`delivery.judgedOn`, REQ-36 BC-18): its name,
   * the project's judge, and how many carried criteria pass on the build it serves of how many.
   * Null where it names none, and the owner's turn reads as it always has (BC-20).
   */
  testing: {
    environment: string;
    judge: VerifiedJudge | null;
    proven: number;
    total: number;
  } | null;
}

type Turn = Standing<ReleaseAttentionGroup, ReleaseWaitingKind>;

const NOBODY = nobodyWaits(say('releases.rule.ended'));

const IN_FLIGHT_ACT: Record<ReleaseAttemptStage, Said> = {
  deploy: say('standing.act.deploying'),
  verify: say('standing.act.verifying'),
};

const YOU = say('standing.who.you');
const MASTER = say('standing.who.master');
const RELEASE_RUN = say('standing.who.releaseRun');

/**
 * A release's turn. Needs you holds decisions only (REQ-48 BC-11, `lib/standing-times.ts:withTimes`
 * for the other slices): an act of the viewer's that no decision carries, a target to declare or a
 * runner to bring online, reads `waiting` on them, so the list and the needs-me read count the same
 * rows. The cut is one: only an admin makes it, so it stays theirs as the `release.cut` decision.
 */
const turn = (
  attentionGroup: ReleaseAttentionGroup,
  kind: ReleaseWaitingKind,
  says: WaitingSays,
): Turn => ({
  attentionGroup:
    attentionGroup === 'needs_you' && !isDecisionActOn('release', says.act)
      ? 'waiting'
      : attentionGroup,
  waitingOn: waitingOn(kind, says),
});

/**
 * A draft a gate holds waits on whoever owes the first act someone can take: the master for an act
 * on its issues, an admin for the project's own setup. Only where every reason is the gate's own —
 * a release running, a check to retry — does it read as waiting on the system (F72).
 */
function gatedTurn(f: TurnFacts): Turn {
  const queued = queuedTurn(f);
  if (queued) return queued;
  const owed = f.gates.find((g) => g.owner.kind !== 'system') ?? f.gates[0];
  const owner = (owed as { owner: ReleaseGateOwner }).owner;
  const n = f.gates.length;
  const rule = say('releases.rule.gated', {
    n,
    reasons: agrees(n, 'reason', 'reasons'),
    verb: agrees(n, 'stands', 'stand'),
    v: f.version,
  });
  const act =
    n > 1
      ? say('standing.act.andMore', {
          act: owner.says.act,
          more: say('standing.more', { n: n - 1 }),
        })
      : owner.says.act;
  const says: WaitingSays = {
    who: owner.says.who,
    act,
    rule,
    ...(owner.says.effect ? { effect: owner.says.effect } : {}),
  };
  if (owner.kind === 'agent') return turn('waiting', 'agent', says);
  if (owner.kind === 'person') {
    return f.viewer?.isAdmin
      ? turn('needs_you', 'you', { ...says, who: YOU })
      : turn('waiting', 'person', says);
  }
  return turn('stuck', 'system', says);
}

/**
 * A draft held by nothing but the release already running is queued behind it, not stuck: the run
 * finishes and the cut is free (JU-8). Any other reason beside it keeps the gated turn.
 */
function queuedTurn(f: TurnFacts): Turn | null {
  const [only] = f.gates;
  if (f.gates.length !== 1 || only?.code !== 'BATCH_IN_FLIGHT') return null;
  return turn('queued', 'system', {
    who: RELEASE_RUN,
    act: only.owner.says.act,
    rule: say('releases.rule.queuedBehindRun', { v: f.version }),
  });
}

function draftTurn(f: TurnFacts): Turn {
  if (f.gates.length > 0) return gatedTurn(f);
  const rule = say('releases.rule.adminCuts');
  const act = say('standing.act.cut', { v: f.version, more: null });
  if (f.viewer?.isAdmin) return turn('needs_you', 'you', { who: YOU, act, rule });
  if (f.admins.length === 0) {
    return turn('stuck', 'none', {
      who: holdersWho(f.admins),
      act: nobodyHoldsAct(act, 'project.admin'),
      rule,
    });
  }
  return turn('waiting', 'person', { who: holdersWho(f.admins), act, rule });
}

/**
 * A release not yet proven on its testing environment (REQ-36 BC-18, BC-19): the owner's review is
 * not theirs yet. It waits on the project's judge to judge each carried criterion on the build that
 * environment serves, and says by the environment's name what is not judged there. Null where the
 * project names no testing environment, or every carried criterion passes there.
 */
function untestedTurn(f: TurnFacts): Turn | null {
  const t = f.testing;
  if (!t || t.total === 0 || t.proven === t.total) return null;
  return turn('waiting', 'agent', {
    who: t.judge === 'independent' ? say('standing.who.independentJudge') : MASTER,
    act: say('standing.act.judgeReleaseOn', { v: f.version, environment: t.environment }),
    rule: say('releases.rule.notJudgedOn', {
      environment: t.environment,
      proven: t.proven,
      total: t.total,
    }),
  });
}

function approvalTurn(f: TurnFacts): Turn {
  const a = f.approval;
  if (a?.decision === null) {
    const untested = untestedTurn(f);
    if (untested) return untested;
  }
  if (!a) {
    const route = f.runId
      ? `POST /api/projects/${f.projectId}/release-batches/${f.runId}/approvals`
      : `POST /api/projects/${f.projectId}/release-batches/<runId>/approvals`;
    return turn('waiting', 'agent', {
      who: MASTER,
      act: say('standing.act.askApproval'),
      rule: say('releases.rule.noRequest', { route }),
    });
  }
  const rule = say('releases.rule.asked', { name: a.requestedBy.name });
  if (f.viewer?.mayApprove && a.decision === null) {
    return turn('needs_you', 'you', {
      who: YOU,
      act: say('standing.act.approveOrReturn', { v: f.version }),
      rule,
    });
  }
  const approvers = f.approvers.map((a) => a.name);
  if (approvers.length === 0) {
    return turn('stuck', 'none', {
      who: holdersWho(approvers),
      act: nobodyHoldsAct(say('standing.act.approve'), 'releases.approve'),
      rule: say('releases.rule.noneLeft', { rule }),
    });
  }
  return turn('waiting', 'person', {
    who: holdersWho(approvers),
    act: say('standing.act.approve'),
    rule,
  });
}

/**
 * A release that landed on a branch production does not deploy from. Production does not serve it:
 * where the project requires a release approval, a holder of releases.approve reviews it and
 * promotes it, and until then it is theirs. Where none is required and no production is declared,
 * the landing is the delivery (owner ruling 2026-10-22) and nobody owes anything. On a project
 * naming its testing environment, the review waits until every carried criterion passes there
 * (`untestedTurn`).
 */
function landedTurn(f: TurnFacts): Turn {
  const branch = f.landedOn ?? '';
  if (!f.required) {
    return {
      attentionGroup: 'done',
      waitingOn: nobodyWaits(say('releases.rule.landedDelivered', { branch })),
    };
  }
  const untested = untestedTurn(f);
  if (untested) return untested;
  const rule = say('releases.rule.landedOwesProduction', { branch });
  const act = say('standing.act.reviewAndPromote', { v: f.version });
  if (f.viewer?.mayApprove) return turn('needs_you', 'you', { who: YOU, act, rule });
  const approvers = f.approvers.map((a) => a.name);
  if (approvers.length === 0) {
    return turn('stuck', 'none', {
      who: holdersWho(approvers),
      act: nobodyHoldsAct(act, 'releases.approve'),
      rule,
    });
  }
  return turn('waiting', 'person', { who: holdersWho(approvers), act, rule });
}

export function turnOf(f: TurnFacts): Turn {
  switch (f.state) {
    case 'draft':
      return draftTurn(f);
    case 'awaiting_approval':
      return approvalTurn(f);
    case 'returned':
      return turn('waiting', 'agent', {
        who: MASTER,
        act: say('standing.act.answerReturn'),
        rule: f.approval?.reason
          ? say('releases.rule.returnedWhy', { why: f.approval.reason })
          : say('releases.rule.returned'),
      });
    case 'in_progress':
      // a change-request release runs no job: once accepted, the master merges its requests in order
      if (f.merges !== null) {
        return turn('waiting', 'agent', {
          who: MASTER,
          act: say('standing.act.mergeInOrder'),
          rule: say('releases.rule.acceptedMerges', {
            n: f.merges,
            requests: agrees(f.merges, 'request', 'requests'),
          }),
        });
      }
      return turn('moving', 'agent', {
        who: RELEASE_RUN,
        act: f.inFlight ? IN_FLIGHT_ACT[f.inFlight] : say('standing.act.starting'),
        rule: say('releases.rule.inProgress'),
      });
    case 'shipped':
      return { attentionGroup: 'done', waitingOn: NOBODY };
    case 'landed':
      return landedTurn(f);
    case 'failed':
    case 'aborted':
      return { attentionGroup: 'stopped', waitingOn: NOBODY };
  }
}

/** One criterion as the release counts it (`release-facts.ts:criteriaAt`). */
export type CountedCriterion = Pick<ReleaseCriterionView, 'standing' | 'proven'>;

/**
 * A release's, or one issue's, criteria counted by the verified rule (contracts `verified-rule.ts:verifiedOf`):
 * proven only where `criteriaAt` read it proven; a fail failing; a pass or short it did not count
 * judged and unproven; anything else (no verdict, skipped, unresolved) open.
 */
export function totalsOf(criteria: readonly CountedCriterion[]): ReleaseCriteriaTotals {
  const proven = criteria.filter((c) => c.proven).length;
  const failing = criteria.filter((c) => !c.proven && c.standing === 'fail').length;
  const unproven = criteria.filter(
    (c) => !c.proven && (c.standing === 'pass' || c.standing === 'short'),
  ).length;
  return {
    proven,
    failing,
    open: criteria.length - proven - failing - unproven,
    unproven,
    total: criteria.length,
  };
}

export function sumTotals(list: readonly ReleaseCriteriaTotals[]): ReleaseCriteriaTotals {
  return list.reduce(
    (a, t) => ({
      proven: a.proven + t.proven,
      failing: a.failing + t.failing,
      open: a.open + t.open,
      unproven: a.unproven + t.unproven,
      total: a.total + t.total,
    }),
    { proven: 0, failing: 0, open: 0, unproven: 0, total: 0 },
  );
}

export function proofOf(t: ReleaseCriteriaTotals): ReleaseProof {
  if (t.total === 0) return 'unrecorded';
  if (t.failing > 0) return 'failing';
  if (t.open > 0) return 'open';
  return t.unproven > 0 ? 'unproven' : 'proven';
}

export interface CompletionFacts {
  key: string;
  title: string;
  status: string;
  state: ReleaseRequirementView['state'];
  coverage: readonly {
    code: string;
    verdict: BcVerdict;
    issues: readonly { issueId: string; criterion: number; stale: boolean }[];
  }[];
  live: readonly { id: string; key: string; status: string }[];
}

export function completionOf(
  req: CompletionFacts,
  inRelease: ReadonlySet<string>,
): ReleaseRequirementView {
  const advances = req.coverage
    .filter((c) => c.issues.some((l) => !l.stale && inRelease.has(l.issueId)))
    .map((c) => ({ code: c.code, verdict: c.verdict }));
  const issues = req.live
    .filter((i) => !inRelease.has(i.id) && i.status !== 'closed')
    .map((i) => i.key);
  const criteria = req.coverage.filter((c) => c.verdict !== 'passing').map((c) => c.code);
  const agreed = isAgreedStatus(req.status);
  return {
    key: req.key,
    title: req.title,
    state: req.state,
    completes: agreed && req.coverage.length > 0 && issues.length === 0 && criteria.length === 0,
    advances,
    remaining: { issues, criteria },
    coverage: criteriaCoverageOf(req.coverage),
  };
}
