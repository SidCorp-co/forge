import { type Db, db } from '../db/client.js';
import { logger } from '../logger.js';
import { findMissingWorkEvidence } from '../pipeline/work-evidence.js';
import type { ActorAgency } from './actor-agency.js';
import type { TransitionErrorCode, TransitionIssueRow } from './apply-transition.js';
import { findUnmetEntryCriteria } from './entry-criteria.js';
import type { EntryCriterionKey } from './entry-criteria-keys.js';

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
  /**
   * What the project declared for `toStatus`, resolved by the caller BEFORE
   * the transaction this runs inside (`entry-criteria.ts` says why).
   */
  declaredCriteria: readonly EntryCriterionKey[];
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

/**
 * ISS-959 requirement 3 — the project's own declaration, held against every
 * client, so a status set from the tracker's screens is earned or refused like
 * one set from a CLI.
 */
const entryCriteriaRule: EvidenceRule = {
  agentOnly: false,
  check: async (ctx) => {
    const shortfall = await findUnmetEntryCriteria({
      issueId: ctx.issue.id,
      declared: ctx.declaredCriteria,
      executor: ctx.executor ?? db,
    });
    if (!shortfall) return null;
    return {
      code: 'ENTRY_CRITERIA_UNMET',
      detail:
        `\`${ctx.toStatus}\` requires ${shortfall.unmet.length === 1 ? 'a record' : 'records'} this project declares, and ` +
        `${shortfall.unmet.length === 1 ? 'it is' : 'they are'} missing: ` +
        shortfall.unmet.map((u) => `${u.key} — ${u.detail}`).join('; '),
      details: {
        issueId: ctx.issue.id,
        toStatus: ctx.toStatus,
        unmet: shortfall.unmet.map((u) => u.key),
      },
    };
  },
};

const RULES: readonly EvidenceRule[] = [noWorkEvidenceRule, entryCriteriaRule];

export async function checkTransitionEvidence(
  ctx: TransitionEvidenceContext,
): Promise<TransitionEvidenceViolation | null> {
  if (ctx.skip) return null;
  try {
    for (const rule of RULES) {
      if (rule.agentOnly && ctx.agency !== 'agent') continue;
      const violation = await rule.check(ctx);
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
