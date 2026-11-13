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
import type { ReleaseOwes } from './release-owes.js';

export interface ViewerFacts {
  userId: string;
  agency: 'human' | 'agent';
  isAdmin: boolean;
  /** Holds releases.approve (`permissions/can.ts:holds`). */
  mayApprove: boolean;
}

/**
 * Whether this viewer decides a release's approval (ISS-1075, FB-543): holding releases.approve is
 * not enough where the one rule gives the approval to a person, so an agent holding the permission
 * reads it as waiting on that person, as every other surface does, and is offered no decision.
 */
export function viewerDecides(
  viewer: ViewerFacts | null,
  owes: ReleaseOwes,
  draft: boolean,
): boolean {
  if (!viewer?.mayApprove) return false;
  return (
    viewer.agency === 'human' ||
    owes(draft ? 'release.decideDraft' : 'release.decide').by !== 'person'
  );
}

interface TurnFacts {
  state: ReleaseState;
  version: string;
  /** The project and run, which the route a master asks approval with names (ISS-591). */
  projectId: string;
  runId: string | null;
  /** The requests a change-request release has still to merge, in order; null on a release that deploys (REQ-71, ISS-1207). */
  merges: number | null;
  /** A promotion release: once its request merged, the record of its production deploy closes it (REQ-63 BC-12). */
  promotion?: boolean;
  /** The branch a recorded landing put it on, off production's branch; null on any other release. */
  landedOn: string | null;
  /** `release.approval.required` of the project document. */
  required: boolean;
  /** Whether the project document declares a production environment; absent reads as none. */
  production?: boolean;
  approval: {
    decision: 'approved' | 'returned' | null;
    requestedBy: ReleasePerson;
    reason: string | null;
    /** Who decided it, where it is decided; absent on a fact built before ISS-1096 read it. */
    decidedBy?: ReleasePerson | null;
  } | null;
  approvers: readonly ReleasePerson[];
  /** Who holds project.admin, by name: whom a cut names where the master does not take it. */
  admins: readonly string[];
  /**
   * Who owes this release's acts, by the one rule read with the project's policy and what the release
   * carries (`release-owes.ts`, ISS-1058): a routine cut is the master's whether or not one stands now.
   */
  owes: ReleaseOwes;
  viewer: ViewerFacts | null;
  /** The blockers, in the order the door refuses in, each with whoever owes its act. */
  gates: readonly { code: string; owner: ReleaseGateOwner }[];
  inFlight: ReleaseAttemptStage | null;
  /**
   * The production deploy its run parked for a person's confirm, not pressed yet (ISS-1096): the run
   * waits on that person, never on itself. Null where none waits.
   */
  prodConfirm?: { bindingId: string } | null;
  /**
   * Whether this project's production deploy waits on a person's confirm (a Coolify production
   * binding deployed on request): the approval says so, so the confirm can be given with it.
   */
  confirmsProduction?: boolean;
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
 * rows. The cut is one where a person makes it: an admin, as the `release.cut` decision, on a project
 * whose master does not take it.
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
    // an approval is the approvers' to decide, every other act the admins' (ISS-1075)
    // the table named a person: an agent is never that person, whatever it holds (ISS-1075)
    const mine =
      f.viewer?.agency === 'human' &&
      (owner.says.act.key === 'standing.act.approveDraftOrReturn'
        ? f.viewer.mayApprove
        : f.viewer.isAdmin);
    return mine ? turn('needs_you', 'you', { ...says, who: YOU }) : turn('waiting', 'person', says);
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

/**
 * A draft no gate holds waits on its cut: the project's master's where the one rule gives it the cut
 * (ISS-1058: routine unless the project is strict or the release carries what cannot be undone), as
 * Needs you, the steward and a room's release read all read it from this one answer (ISS-1043);
 * otherwise its admins', a person's decision.
 */
function draftTurn(f: TurnFacts): Turn {
  if (f.gates.length > 0) return gatedTurn(f);
  const act = say('standing.act.cut', { v: f.version, more: null });
  if (f.owes('release.cut').by === 'master') {
    // the door named, since a release has no cut route of its own (ISS-1232)
    const route = `POST /api/projects/${f.projectId}/release-batches`;
    return turn('waiting', 'agent', {
      who: MASTER,
      act,
      rule: say('releases.rule.masterCuts', { route }),
    });
  }
  const rule = say('releases.rule.adminCuts');
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

/**
 * A release whose production deploy waits on a person's confirm (ISS-1096): the run stays open and
 * waits on whoever may press it, the confirm door's holders of project.admin, named first by the
 * approver where they hold it. A person among them reads it as theirs, in Needs you; an agent
 * holding the permission is never that person.
 */
function confirmTurn(f: TurnFacts, bindingId: string): Turn {
  const route = `POST /api/projects/${f.projectId}/integrations/${bindingId}/confirm-prod-deploy`;
  const act = say('standing.act.confirmProdDeploy', { v: f.version });
  const rule = say('releases.rule.awaitsProdConfirm', { route });
  if (f.viewer?.agency === 'human' && f.viewer.isAdmin) {
    return turn('needs_you', 'you', { who: YOU, act, rule });
  }
  if (f.admins.length === 0) {
    return turn('stuck', 'none', {
      who: holdersWho(f.admins),
      act: nobodyHoldsAct(act, 'project.admin'),
      rule,
    });
  }
  const approver = f.approval?.decidedBy?.name;
  const who = approver && f.admins.includes(approver) ? [approver] : f.admins;
  return turn('waiting', 'person', { who: holdersWho(who), act, rule });
}

/** What approving says where the production deploy then waits on a person's confirm (ISS-1096). */
const confirmEffect = (f: TurnFacts) =>
  f.confirmsProduction ? { effect: say('releases.effect.confirmAfterApproval') } : {};

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
  if (viewerDecides(f.viewer, f.owes, false) && a.decision === null) {
    return turn('needs_you', 'you', {
      who: YOU,
      act: say('standing.act.approveOrReturn', { v: f.version }),
      rule,
      ...confirmEffect(f),
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
    ...confirmEffect(f),
  });
}

/**
 * A release that landed on a branch production does not deploy from. Production does not serve it:
 * where the project requires a release approval, a holder of releases.approve reviews it and
 * promotes it, and until then it is theirs. Where none is required and no production is declared,
 * the landing is the delivery (owner ruling 2026-10-22) and nobody owes anything. Where none is
 * required and production is declared, production does not serve it yet: whoever cuts its releases
 * promotes it, and it is never read done (ISS-709, judge K104). On a project
 * naming its testing environment, the review waits until every carried criterion passes there
 * (`untestedTurn`).
 */
/** A landed release with production declared and no approval asked: its cutter promotes it. */
function promotionTurn(f: TurnFacts, branch: string): Turn {
  const act = say('standing.act.reviewAndPromote', { v: f.version });
  const rule = say('releases.rule.landedOwesPromotion', { branch });
  if (f.owes('release.cut').by === 'master')
    return turn('waiting', 'agent', { who: MASTER, act, rule });
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

function landedTurn(f: TurnFacts): Turn {
  const branch = f.landedOn ?? '';
  if (!f.required && !f.production) {
    return {
      attentionGroup: 'done',
      waitingOn: nobodyWaits(say('releases.rule.landedDelivered', { branch })),
    };
  }
  if (!f.required) return promotionTurn(f, branch);
  const untested = untestedTurn(f);
  if (untested) return untested;
  const rule = say('releases.rule.landedOwesProduction', { branch });
  const act = say('standing.act.reviewAndPromote', { v: f.version });
  if (viewerDecides(f.viewer, f.owes, false))
    return turn('needs_you', 'you', { who: YOU, act, rule });
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

/**
 * An accepted change-request release whose requests a person merges on the host (`release.mergedBy`,
 * ISS-1090): the merges wait on the release's approvers, the viewer among them where they hold
 * releases.approve, and never on the master.
 */
function personMergesTurn(f: TurnFacts, n: number): Turn {
  const says = {
    act: say('standing.act.mergeInOrder'),
    rule: say('releases.rule.personMerges', { n, requests: agrees(n, 'request', 'requests') }),
  };
  if (f.viewer?.mayApprove && f.viewer.agency === 'human') {
    return turn('waiting', 'you', { who: YOU, ...says });
  }
  return turn('waiting', 'person', { who: holdersWho(f.approvers.map((a) => a.name)), ...says });
}

/**
 * A promotion release whose request merged (ISS-1207, `change-request-settle.ts` pending `record`):
 * production is deployed outside Forge, and the record of that deploy closes it. The approval that
 * accepted it was the go to production, so where it stands the record is the master's by the one
 * rule, and no person is asked again for the same release (ISS-1206).
 */
function recordTurn(f: TurnFacts): Turn {
  const act = say('standing.act.recordRelease');
  const rule = say('releases.rule.mergedAwaitsRecord', { v: f.version });
  if (f.owes('release.record').by === 'master') {
    return turn('waiting', 'agent', { who: MASTER, act, rule });
  }
  const approvers = f.approvers.map((a) => a.name);
  if (f.viewer?.agency === 'human' && f.viewer.mayApprove) {
    return turn('waiting', 'you', { who: YOU, act, rule });
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
      // a change-request release runs no job: once accepted, the master merges its requests in order,
      // unless the project says a person merges them on the host (ISS-1090)
      if (f.merges !== null && f.merges > 0 && f.owes('release.merge').by === 'person') {
        return personMergesTurn(f, f.merges);
      }
      if (f.merges !== null && f.merges > 0) {
        return turn('waiting', 'agent', {
          who: MASTER,
          act: say('standing.act.mergeInOrder'),
          rule: say('releases.rule.acceptedMerges', {
            n: f.merges,
            requests: agrees(f.merges, 'request', 'requests'),
          }),
        });
      }
      if (f.prodConfirm) return confirmTurn(f, f.prodConfirm.bindingId);
      // every request merged: a promotion waits on the record of its deploy (ISS-1207)
      if (f.merges === 0 && f.promotion) return recordTurn(f);
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

/** Standings judged and not proven: a short, a pass the verified rule does not count, or one an
 *  owner's decision accepts on another proof (REQ-36 BC-22), which owes no live verdict. */
const judgedUnproven = (c: CountedCriterion) =>
  !c.proven && (c.standing === 'pass' || c.standing === 'short' || c.standing === 'accepted');

/**
 * A release's, or one issue's, criteria counted by the verified rule (contracts `verified-rule.ts:verifiedOf`):
 * proven only where `criteriaAt` read it proven; a fail failing; a pass or short it did not count, or
 * one accepted on a decision, judged and unproven; anything else (no verdict, skipped, unresolved) open.
 */
export function totalsOf(criteria: readonly CountedCriterion[]): ReleaseCriteriaTotals {
  const proven = criteria.filter((c) => c.proven).length;
  const failing = criteria.filter((c) => !c.proven && c.standing === 'fail').length;
  const unproven = criteria.filter(judgedUnproven).length;
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

/**
 * ISS-1218: where every criterion still open stands `skipped` (no route to judge it), what each skip
 * names missing; null where any open one has no verdict at the build, a fail stands, or none is open.
 * One accepted on a decision is not open (ISS-1223), so the skips beside it still say the wait.
 */
export function unreachedOf(
  criteria: readonly (CountedCriterion & Pick<ReleaseCriterionView, 'reason'>)[],
): string[] | null {
  const open = criteria.filter((c) => !c.proven && !judgedUnproven(c));
  if (open.length === 0 || open.some((c) => c.standing !== 'skipped')) return null;
  return open.map((c) => c.reason ?? 'no reason recorded');
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
