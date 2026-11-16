import { type Db, db } from '../db/client.js';
import { logger } from '../logger.js';
import { findMissingWorkEvidence } from '../pipeline/work-evidence.js';
import { markCommitCheck } from '../projects/live-source.js';
import type { ActorAgency } from './actor-agency.js';
import type { TransitionErrorCode, TransitionIssueRow } from './apply-transition.js';
import { findUnmetEntryCriteria } from './entry-criteria.js';
import {
  type EntryCriterionKey,
  entryRecordsMissingWords,
  entryRecordsWrittenBy,
  type MissingMarkShape,
} from './entry-criteria-keys.js';
import { readLandingEvidence } from './landing-evidence.js';
import { statusLabel } from './status-sets.js';

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
  /** Set by `applyStatusTransition` for a close taken by an agent off the release path. */
  releaseNoteOwed?: boolean;
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

/** A close refused for its records says the move that claims no ship, for work that was not work. */
const CLOSE_INSTEAD = 'If it turned out not to be work, move it to Dropped instead.';

/**
 * ISS-959 requirement 3 — the project's own declaration, held against every
 * client, so a status set from the tracker's screens is earned or refused like
 * one set from a CLI. `skip` waives the declaration, never the release note an agent's close owes,
 * and one refusal names every record missing.
 */
const entryCriteriaRule: EvidenceRule = {
  agentOnly: false,
  check: async (ctx) => {
    const declared = ctx.skip ? [] : ctx.declaredCriteria;
    const noteOnlyOwed = ctx.releaseNoteOwed === true && !declared.includes('release_note');
    const required: EntryCriterionKey[] = [
      ...declared,
      ...(noteOnlyOwed ? (['release_note'] as const) : []),
    ];
    const shortfall = await findUnmetEntryCriteria({
      issueId: ctx.issue.id,
      declared: required,
      executor: ctx.executor ?? db,
    });
    if (!shortfall) return null;
    const unmet = shortfall.unmet.map((u) => u.key);
    // The agent-only note keeps the code an agent has always been refused a close with.
    const owedNoteMissing = noteOnlyOwed && unmet.includes('release_note');
    return {
      code: owedNoteMissing ? 'RELEASE_RECORD_REQUIRED' : 'ENTRY_CRITERIA_UNMET',
      // A short sentence per record by its name; each record's whole step stays in `steps`.
      detail: [
        entryRecordsMissingWords(ctx.toStatus, statusLabel(ctx.toStatus), unmet),
        ...entryRecordsWrittenBy(unmet, await missingMarkShape(ctx, unmet)),
        ...(ctx.toStatus === 'closed' ? [CLOSE_INSTEAD] : []),
      ].join(' '),
      details: {
        issueId: ctx.issue.id,
        toStatus: ctx.toStatus,
        unmet,
        steps: Object.fromEntries(shortfall.unmet.map((u) => [u.key, u.detail])),
        ...(owedNoteMissing ? { requires: 'releaseNotes' } : {}),
      },
    };
  },
};

/** How a missing mark is made: its lane, and in git what its Commit takes on the project (ISS-1421
 *  r41-r43). Read only where a mark is what is missing; a read that
 *  fails leaves the sentence saying only what the mark records rather than the refusal unmade. */
async function missingMarkShape(
  ctx: TransitionEvidenceContext,
  unmet: readonly string[],
): Promise<MissingMarkShape | null> {
  if (!unmet.includes('merged_mark')) return null;
  try {
    const evidence = await readLandingEvidence(ctx.executor ?? db, ctx.issue.id);
    if (evidence && evidence.lane.shape !== 'git') return { outsideGit: true, commit: null };
    return { outsideGit: false, commit: await markCommitCheck(ctx.issue.projectId) };
  } catch (err) {
    logger.warn(
      { err, issueId: ctx.issue.id },
      'transition-evidence: the landing lane could not be read',
    );
    return null;
  }
}

const RULES: readonly EvidenceRule[] = [noWorkEvidenceRule, entryCriteriaRule];

export async function checkTransitionEvidence(
  ctx: TransitionEvidenceContext,
): Promise<TransitionEvidenceViolation | null> {
  if (ctx.skip && ctx.releaseNoteOwed !== true) return null;
  try {
    for (const rule of RULES) {
      if (ctx.skip && rule !== entryCriteriaRule) continue;
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
