/**
 * Content guards on THE state-machine writer (`transitionIssueStatus`).
 * Rules run for an agent caller only — a human hand-advance is a
 * recorded human decision, not the fabrication class this guards against —
 * and are skipped entirely for `options.skip===true` (the orchestrator's
 * curated soft-skip/failover chain, which legitimately lands on gated
 * statuses without the evidence a normal write would require). This is the
 * shared extension point ISS-821 (ISS-786 child B) extends with a second
 * rule (`no_work_evidence`).
 */

import { eq } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { logger } from '../logger.js';
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

type EvidenceRule = (ctx: TransitionEvidenceContext) => Promise<TransitionEvidenceViolation | null>;

export const isBlankPlan = (plan: string | null | undefined): boolean =>
  !plan || plan.trim().length === 0;

/**
 * Statuses that assert "code exists". `closed`/`released` are deliberately
 * excluded — a coordination epic legitimately reaches them with no
 * branch of its own (its children carry the code), and `markMergedOnClose`'s
 * unconditional stamp on `closed` is out of scope for this rule (ISS-786
 * epic explicitly forbids re-litigating it).
 */
const NO_WORK_EVIDENCE_STATUSES: ReadonlySet<string> = new Set(['developed', 'testing']);

/**
 * Requirement 1 (ISS-786 child B) — `developed`/`testing` must not be
 * reachable with zero recorded evidence that code exists (ISS-105 / ISS-75-78
 * shape: a status advance with no branch, commit or handoff behind it).
 */
const noWorkEvidenceRule: EvidenceRule = async (ctx) => {
  if (!NO_WORK_EVIDENCE_STATUSES.has(ctx.toStatus)) return null;
  const detail = await findMissingWorkEvidence(ctx.issue.id, ctx.executor ?? db);
  if (!detail) return null;
  return {
    code: 'NO_WORK_EVIDENCE',
    detail,
    details: { issueId: ctx.issue.id, toStatus: ctx.toStatus },
  };
};

const RULES: readonly EvidenceRule[] = [noWorkEvidenceRule];

// cm:guard fails OPEN on any internal error — a broken content guard must never freeze the writer
export async function checkTransitionEvidence(
  ctx: TransitionEvidenceContext,
): Promise<TransitionEvidenceViolation | null> {
  if (ctx.agency !== 'agent' || ctx.skip) return null;
  try {
    for (const rule of RULES) {
      const violation = await rule(ctx);
      if (violation) return violation;
    }
    return null;
  } catch (err) {
    logger.error(
      { err, issueId: ctx.issue.id, toStatus: ctx.toStatus },
      'transition-evidence: rule check failed, allowing transition',
    );
    return null;
  }
}
