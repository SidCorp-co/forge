import { eq } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';
import { logger } from '../logger.js';
import { readPipelineConfig } from '../pipeline/autonomous-project.js';
import { findMissingWorkEvidence, missingWorkEvidenceStrict } from '../pipeline/work-evidence.js';
import type { EntryCriterionKey } from './entry-criteria-keys.js';
import { mergedMarkShortfall } from './entry-criteria-merge-mark.js';

type CriterionExecutor = Pick<Db, 'select'>;

export interface EntryCriteriaShortfall {
  unmet: { key: EntryCriterionKey; detail: string }[];
}

type IssueRecord = {
  plan: string | null;
  acceptanceCriteria: string | null;
  releaseNotes: unknown;
  mergedAt: Date | null;
  mergedCommitSha: string | null;
};

type Criterion = (
  issueId: string,
  record: IssueRecord,
  executor: CriterionExecutor,
) => Promise<string | null> | string | null;

const isBlank = (v: string | null): boolean => v == null || v.trim().length === 0;

const criteriaWith = (
  workEvidence: (id: string, executor: CriterionExecutor) => Promise<string | null>,
): Record<EntryCriterionKey, Criterion> => ({
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
  work_evidence: (id, _record, executor) => workEvidence(id, executor),
  // Which kinds count as landed, and the refusal: `entry-criteria-merge-mark.ts`.
  merged_mark: (_id, record) => mergedMarkShortfall(record),
});

const CRITERIA = criteriaWith((id, executor) => findMissingWorkEvidence(id, executor));
const STRICT_CRITERIA = criteriaWith((id, executor) => missingWorkEvidenceStrict(id, executor));

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
      mergedCommitSha: issues.mergedCommitSha,
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

/**
 * ISS-1072 — the same declaration and the same five criteria, read strictly and
 * returned whole, for a caller that PUBLISHES the answer instead of gating on it.
 *
 * Three differences from the pair above, and each is the same reason. The config
 * read is not swallowed, because `[]` from a failed read and `[]` from a project
 * that declared nothing are one value here and the first is a lie on a pull
 * request. `work_evidence` runs the strict check, for the same reason one rung
 * down. And what comes back names the MET criteria as well as the unmet, because
 * "nothing is missing" and "nothing was asked" are the two answers a reader of a
 * check run most needs told apart.
 *
 * It throws where it cannot answer. That is the point: the caller renders the
 * refusal rather than a verdict it did not earn.
 */
export interface EntryCriteriaReading {
  declared: EntryCriterionKey[];
  met: EntryCriterionKey[];
  unmet: { key: EntryCriterionKey; detail: string }[];
}

export async function readEntryCriteriaStrict(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  executor?: CriterionExecutor;
}): Promise<EntryCriteriaReading> {
  const executor = args.executor ?? db;
  const config = await readPipelineConfig(args.projectId, executor);
  if (!config) {
    throw new Error(`the pipeline configuration for project ${args.projectId} could not be read`);
  }
  const declared = config.statusEntryCriteria?.[args.status] ?? [];
  if (declared.length === 0) return { declared: [], met: [], unmet: [] };
  const [record] = await executor
    .select({
      plan: issues.plan,
      acceptanceCriteria: issues.acceptanceCriteria,
      releaseNotes: issues.releaseNotes,
      mergedAt: issues.mergedAt,
      mergedCommitSha: issues.mergedCommitSha,
    })
    .from(issues)
    .where(eq(issues.id, args.issueId))
    .limit(1);
  if (!record) throw new Error(`no issue row for ${args.issueId}`);

  const met: EntryCriterionKey[] = [];
  const unmet: EntryCriteriaReading['unmet'] = [];
  for (const key of declared) {
    const detail = await STRICT_CRITERIA[key](args.issueId, record, executor);
    if (detail) unmet.push({ key, detail });
    else met.push(key);
  }
  return { declared: [...declared], met, unmet };
}
