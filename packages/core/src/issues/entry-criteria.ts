/**
 * ISS-959 — the records a status entry requires, declared by the project and
 * checked on the server for every client.
 *
 * Core already had entry rules, and every one of them was an AGENT rule:
 * `transition-evidence.ts` returns early unless the actor is an agent, and so
 * do `release-record-required.ts` and `release-gate-hold.ts`. That carve-out
 * is deliberate where it exists — a person hand-advancing makes a claim
 * deliberately and owns it — but it left a whole half of the surface
 * unchecked: the same status set from the tracker's own screens was neither
 * earned nor refused. Measured on forge-dev, 2026-09-07: a `forge record`
 * write and a `forge comment` write each moved an issue from `needs_info` back
 * to `open`, and on that project `open` is what makes an issue claimable, so a
 * silent un-park is a live path to two agents on one issue.
 *
 * So the project declares which records a status entry requires, and the
 * declaration is enforced against everybody. WHICH criteria a status carries
 * is the project's decision and is not in this module; the vocabulary and the
 * enforcement are.
 */

import { eq } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';
import { logger } from '../logger.js';
import { readPipelineConfig } from '../pipeline/autonomous-project.js';
import { findMissingWorkEvidence } from '../pipeline/work-evidence.js';
import type { EntryCriterionKey } from './entry-criteria-keys.js';

type CriterionExecutor = Pick<Db, 'select'>;

export interface EntryCriteriaShortfall {
  unmet: { key: EntryCriterionKey; detail: string }[];
}

type IssueRecord = {
  plan: string | null;
  acceptanceCriteria: string | null;
  releaseNotes: unknown;
  mergedAt: Date | null;
};

type Criterion = (
  issueId: string,
  record: IssueRecord,
  executor: CriterionExecutor,
) => Promise<string | null> | string | null;

const isBlank = (v: string | null): boolean => v == null || v.trim().length === 0;

const CRITERIA: Record<EntryCriterionKey, Criterion> = {
  plan: (_id, record) =>
    isBlank(record.plan)
      ? 'no `plan` is written on this issue — write the plan field before this status'
      : null,
  acceptance_criteria: (_id, record) =>
    isBlank(record.acceptanceCriteria)
      ? 'no `acceptanceCriteria` is written on this issue — write the criteria before this status'
      : null,
  release_note: (_id, record) =>
    record.releaseNotes == null
      ? 'no `releaseNotes` is written on this issue — `{ section, userFacing }`, or ' +
        "`{ section: 'Skip', userFacing: '-' }` when the change has no user-facing half"
      : null,
  work_evidence: (id, _record, executor) => findMissingWorkEvidence(id, executor),
  merged_mark: (_id, record) =>
    record.mergedAt == null
      ? 'this issue carries no merged mark — mark it merged, naming the commit it landed at, before this status'
      : null,
};

/**
 * What the project declared for the status being entered, or an empty list.
 *
 * Read by the caller BEFORE the transaction, never inside it: a `projects`
 * SELECT inside every status transition's transaction is what ISS-863 removed
 * from `merged-at.ts`, and re-adding one here would put it back.
 */
export async function resolveDeclaredEntryCriteria(
  projectId: string,
  toStatus: IssueStatus,
): Promise<EntryCriterionKey[]> {
  try {
    const config = await readPipelineConfig(projectId);
    return config?.statusEntryCriteria?.[toStatus] ?? [];
  } catch (err) {
    logger.warn({ err, projectId, toStatus }, 'entry_criteria.read_failed');
    return [];
  }
}

/**
 * Which of the declared criteria this issue does not meet, in declaration
 * order. `null` when it meets all of them, or when none were declared.
 */
export async function findUnmetEntryCriteria(args: {
  issueId: string;
  declared: readonly EntryCriterionKey[];
  executor?: CriterionExecutor;
}): Promise<EntryCriteriaShortfall | null> {
  if (args.declared.length === 0) return null;
  const executor = args.executor ?? db;

  const [record] = await executor
    .select({
      plan: issues.plan,
      acceptanceCriteria: issues.acceptanceCriteria,
      releaseNotes: issues.releaseNotes,
      mergedAt: issues.mergedAt,
    })
    .from(issues)
    .where(eq(issues.id, args.issueId))
    .limit(1);
  if (!record) return null;

  const unmet: EntryCriteriaShortfall['unmet'] = [];
  for (const key of args.declared) {
    const detail = await CRITERIA[key](args.issueId, record, executor);
    if (detail) unmet.push({ key, detail });
  }
  return unmet.length > 0 ? { unmet } : null;
}
