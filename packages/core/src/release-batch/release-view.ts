import type { CriterionStanding } from '@forge/contracts/issue-vocabulary';
import type {
  ReleaseAttemptStage,
  ReleaseAttentionGroup,
  ReleaseCriteriaTotals,
  ReleaseGateOwner,
  ReleasePerson,
  ReleaseProof,
  ReleaseRequirementView,
  ReleaseState,
  ReleaseWaitingKind,
} from '@forge/contracts/releases';
import type { BcVerdict } from '@forge/contracts/requirements';
import { type Said, say } from '@forge/contracts/said';
import {
  holdersWho,
  nobodyHoldsAct,
  nobodyWaits,
  type Standing,
  type WaitingSays,
  waitingOn,
} from '@forge/contracts/standing';
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

const turn = (
  attentionGroup: ReleaseAttentionGroup,
  kind: ReleaseWaitingKind,
  says: WaitingSays,
): Turn => ({ attentionGroup, waitingOn: waitingOn(kind, says) });

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

function approvalTurn(f: TurnFacts): Turn {
  const a = f.approval;
  if (!a) {
    return turn('waiting', 'agent', {
      who: MASTER,
      act: say('standing.act.askApproval'),
      rule: say('releases.rule.noRequest'),
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
      return turn('moving', 'agent', {
        who: RELEASE_RUN,
        act: f.inFlight ? IN_FLIGHT_ACT[f.inFlight] : say('standing.act.starting'),
        rule: say('releases.rule.inProgress'),
      });
    case 'shipped':
      return { attentionGroup: 'done', waitingOn: NOBODY };
    case 'failed':
    case 'aborted':
      return { attentionGroup: 'stopped', waitingOn: NOBODY };
  }
}

export function totalsOf(standings: readonly CriterionStanding[]): ReleaseCriteriaTotals {
  const proven = standings.filter((s) => s === 'pass').length;
  const failing = standings.filter((s) => s === 'fail').length;
  return { proven, failing, open: standings.length - proven - failing, total: standings.length };
}

export function sumTotals(list: readonly ReleaseCriteriaTotals[]): ReleaseCriteriaTotals {
  return list.reduce(
    (a, t) => ({
      proven: a.proven + t.proven,
      failing: a.failing + t.failing,
      open: a.open + t.open,
      total: a.total + t.total,
    }),
    { proven: 0, failing: 0, open: 0, total: 0 },
  );
}

export function proofOf(t: ReleaseCriteriaTotals): ReleaseProof {
  if (t.total === 0) return 'unrecorded';
  if (t.failing > 0) return 'failing';
  return t.open > 0 ? 'open' : 'proven';
}

const SECTION_ORDER = ['Added', 'Changed', 'Fixed', 'Removed', 'Security'];
const HEADLINE_LINES = 2;
const HEADLINE_WIDTH = 72;

const clip = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > HEADLINE_WIDTH ? `${t.slice(0, HEADLINE_WIDTH - 1).trimEnd()}…` : t;
};

export function headlineOf(items: readonly { section: string | null; text: string }[]): string {
  const rank = (s: string | null) => {
    const at = s === null ? -1 : SECTION_ORDER.indexOf(s);
    return at === -1 ? SECTION_ORDER.length : at;
  };
  const sorted = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => rank(a.it.section) - rank(b.it.section) || a.i - b.i)
    .map((x) => clip(x.it.text))
    .filter((t) => t.length > 0);
  const shown = sorted.slice(0, HEADLINE_LINES).join('; ');
  const rest = sorted.length - HEADLINE_LINES;
  return rest > 0 ? `${shown}; +${rest} more` : shown;
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
  const agreed = req.status === 'agreed' || req.status === 'accepted';
  return {
    key: req.key,
    title: req.title,
    state: req.state,
    completes: agreed && req.coverage.length > 0 && issues.length === 0 && criteria.length === 0,
    advances,
    remaining: { issues, criteria },
  };
}
