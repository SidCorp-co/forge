import { type Db, db } from '../db/client.js';
import { findMissingWorkEvidence } from '../pipeline/work-evidence.js';
import type { ActorAgency } from './actor-agency.js';
import type { TransitionErrorCode, TransitionIssueRow } from './apply-transition.js';

export interface TransitionEvidenceViolation {
  code: TransitionErrorCode;
  detail: string;
  details: Record<string, unknown>;
}

type EvidenceExecutor = Pick<Db, 'select'>;

export interface TransitionEvidenceContext {
  issue: Pick<TransitionIssueRow, 'id' | 'projectId'>;
  toStatus: string;
  agency: ActorAgency;
  skip: boolean;
  executor?: EvidenceExecutor;
}

type EvidenceRule = {
  /** `true` exempts a human hand-advance; `false` holds every actor to the rule. */
  agentOnly: boolean;
  check: (ctx: TransitionEvidenceContext) => Promise<TransitionEvidenceViolation | null>;
};

export const isBlankPlan = (plan: string | null | undefined): boolean =>
  !plan || plan.trim().length === 0;

const NO_WORK_EVIDENCE_STATUSES: ReadonlySet<string> = new Set(['developed', 'testing']);

/**
 * Requirement 1 (ISS-786 child B) — `developed`/`testing` must not be
 * reachable with zero recorded evidence that code exists (ISS-105 / ISS-75-78
 * shape: a status advance with no branch, commit or handoff behind it).
 */
const noWorkEvidenceRule: EvidenceRule = {
  agentOnly: true,
  check: async (ctx) => {
    if (!NO_WORK_EVIDENCE_STATUSES.has(ctx.toStatus)) return null;
    const detail = await findMissingWorkEvidence(ctx.issue.id, ctx.executor ?? db);
    if (!detail) return null;
    return {
      code: 'NO_WORK_EVIDENCE',
      detail,
      details: { issueId: ctx.issue.id, toStatus: ctx.toStatus },
    };
  },
};

const RULES: readonly EvidenceRule[] = [noWorkEvidenceRule];

export async function checkTransitionEvidence(
  ctx: TransitionEvidenceContext,
): Promise<TransitionEvidenceViolation | null> {
  if (ctx.skip) return null;
  // cm:guard a rule that cannot be read refuses the transition by throwing, never allows it: this
  // runs inside the transition's transaction, which a failed read has already aborted, and a
  // kernel transition that skips its evidence rule on an error is the silence it exists to stop.
  for (const rule of RULES) {
    if (rule.agentOnly && ctx.agency !== 'agent') continue;
    const violation = await rule.check(ctx);
    if (violation) return violation;
  }
  return null;
}
