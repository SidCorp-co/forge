import type { CriterionStanding } from '@forge/contracts/issue-vocabulary';
import type {
  ReleaseAttemptStage,
  ReleaseAttentionGroup,
  ReleaseCriteriaTotals,
  ReleasePerson,
  ReleaseProof,
  ReleaseRequirementView,
  ReleaseState,
  ReleaseWaitingKind,
} from '@forge/contracts/releases';
import { nobodyWaits, type Standing } from '@forge/contracts/standing';
import type { BcVerdict } from '@forge/contracts/requirements';
import { agrees, counted } from '../lib/plural.js';

export interface ViewerFacts {
  userId: string;
  agency: 'human' | 'agent';
  isAdmin: boolean;
  /** Holds releases.approve (`permissions/can.ts:holds`). */
  mayApprove: boolean;
}

export interface TurnFacts {
  state: ReleaseState;
  version: string;
  approval: {
    decision: 'approved' | 'returned' | null;
    requestedBy: ReleasePerson;
    reason: string | null;
  } | null;
  approvers: readonly ReleasePerson[];
  viewer: ViewerFacts | null;
  gates: readonly { title: string }[];
  inFlight: ReleaseAttemptStage | null;
  crossedBounds: readonly string[];
}

export type Turn = Standing<ReleaseAttentionGroup, ReleaseWaitingKind>;

const NOBODY = nobodyWaits('the release has ended');

const IN_FLIGHT_ACT: Record<ReleaseAttemptStage, string> = {
  promote: 'promoting',
  deploy: 'deploying',
  verify: 'verifying',
  repair: 'repairing',
};

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function draftTurn(f: TurnFacts): Turn {
  if (f.gates.length > 0) {
    const more = f.gates.length > 1 ? ` and ${f.gates.length - 1} more` : '';
    return {
      attentionGroup: 'stuck',
      waitingOn: {
        kind: 'system',
        who: 'Release gate',
        act: `${lower((f.gates[0] as { title: string }).title)}${more}`,
        rule: `${counted(f.gates.length, 'reason')} ${agrees(f.gates.length, 'stands', 'stand')} against cutting ${f.version}`,
        ref: null,
        dueAt: null,
      },
    };
  }
  const rule =
    'merged issues wait at the release gate, no gate holds them, and an admin cuts the version';
  if (f.viewer?.isAdmin) {
    return {
      attentionGroup: 'needs_you',
      waitingOn: { kind: 'you', who: 'You', act: `cut ${f.version}`, rule, ref: null, dueAt: null },
    };
  }
  return {
    attentionGroup: 'waiting',
    waitingOn: { kind: 'person', who: 'A project admin', act: `cut ${f.version}`, rule, ref: null, dueAt: null },
  };
}

function approvalTurn(f: TurnFacts): Turn {
  const a = f.approval;
  if (!a) {
    return {
      attentionGroup: 'waiting',
      waitingOn: {
        kind: 'agent',
        who: 'Master',
        act: 'ask for approval',
        rule: 'the project requires approval before production and no request is open',
        ref: null,
        dueAt: null,
      },
    };
  }
  const rule = `${a.requestedBy.name} asked; a holder of releases.approve approves or returns it`;
  if (f.viewer?.mayApprove && a.decision === null) {
    return {
      attentionGroup: 'needs_you',
      waitingOn: { kind: 'you', who: 'You', act: `approve or return ${f.version}`, rule, ref: null, dueAt: null },
    };
  }
  const [only] = f.approvers;
  if (f.approvers.length === 0) {
    return {
      attentionGroup: 'stuck',
      waitingOn: {
        kind: 'none',
        who: 'No approver',
        act: 'no other admin can decide',
        rule: `${rule}, and none is left`,
        ref: null,
        dueAt: null,
      },
    };
  }
  return {
    attentionGroup: 'waiting',
    waitingOn: {
      kind: 'person',
      who: f.approvers.length === 1 && only ? only.name : 'A project admin',
      act: 'approve',
      rule,
      ref: null,
      dueAt: null,
    },
  };
}

export function turnOf(f: TurnFacts): Turn {
  switch (f.state) {
    case 'draft':
      return draftTurn(f);
    case 'awaiting_approval':
      return approvalTurn(f);
    case 'returned':
      return {
        attentionGroup: 'waiting',
        waitingOn: {
          kind: 'agent',
          who: 'Master',
          act: 'answer the return',
          rule: `an admin returned it${f.approval?.reason ? `: ${f.approval.reason}` : ''}; the master answers before it asks again`,
          ref: null,
          dueAt: null,
        },
      };
    case 'in_progress':
      if (f.crossedBounds.length > 0) {
        return {
          attentionGroup: 'stuck',
          waitingOn: {
            kind: 'system',
            who: 'Release run',
            act: `crossed its ${f.crossedBounds.join(' and ')} bound`,
            rule: 'a bound on the run is crossed, so it no longer reads as moving',
            ref: null,
            dueAt: null,
          },
        };
      }
      return {
        attentionGroup: 'moving',
        waitingOn: {
          kind: 'agent',
          who: 'Release run',
          act: f.inFlight ? IN_FLIGHT_ACT[f.inFlight] : 'starting',
          rule: 'the release run is working on production',
          ref: null,
          dueAt: null,
        },
      };
    case 'shipped':
      return { attentionGroup: 'done', waitingOn: NOBODY };
    case 'rolled_back':
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
