import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import { issueDependencies, issueStepContexts, issues, jobs, projects } from '../db/schema.js';
import { WORK_EVIDENCE_WAIVER_KIND } from '../issues/dependency-effects.js';
import { logger } from '../logger.js';
import { readableLiveBranch } from '../projects/release-model.js';

const IMPLEMENTATION_STEPS = ['code', 'fix', 'drive'] as const;

const JOB_SCAN_LIMIT = 50;
const HANDOFF_SCAN_LIMIT = 50;

type EvidenceExecutor = Pick<Db, 'select'>;

export interface WorkEvidence {
  implementationJobCount: number;
  handoffCommitSha: string | null;
  handoffFilesModified: number;
  branch: string | null;
}

export async function collectWorkEvidence(
  issueId: string,
  executor: EvidenceExecutor = db,
): Promise<WorkEvidence> {
  const [jobRows, handoffRows, issueRows] = await Promise.all([
    executor
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.issueId, issueId), inArray(jobs.type, IMPLEMENTATION_STEPS)))
      .limit(JOB_SCAN_LIMIT),
    executor
      .select({ payload: issueStepContexts.payload })
      .from(issueStepContexts)
      .where(
        and(
          eq(issueStepContexts.issueId, issueId),
          eq(issueStepContexts.kind, 'handoff'),
          inArray(issueStepContexts.step, IMPLEMENTATION_STEPS),
        ),
      )
      .limit(HANDOFF_SCAN_LIMIT),
    executor
      .select({
        sessionContext: issues.sessionContext,
        baseBranch: projects.baseBranch,
        liveBranch: projects.liveBranch,
        releaseModel: projects.releaseModel,
      })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(eq(issues.id, issueId))
      .limit(1),
  ]);

  let handoffCommitSha: string | null = null;
  let handoffFilesModified = 0;
  for (const row of handoffRows) {
    const payload = row.payload as Record<string, unknown> | null;
    if (!payload) continue;
    if (
      !handoffCommitSha &&
      typeof payload.commitSha === 'string' &&
      payload.commitSha.length > 0
    ) {
      handoffCommitSha = payload.commitSha;
    }
    if (Array.isArray(payload.filesModified)) {
      handoffFilesModified += payload.filesModified.length;
    }
  }

  const sessionContext = issueRows[0]?.sessionContext as Record<string, unknown> | null | undefined;
  const worklog = sessionContext?.worklog as Record<string, unknown> | null | undefined;
  const named = [sessionContext?.branch, worklog?.branch].find(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  const projectRow = issueRows[0];
  const excludedLive = projectRow ? readableLiveBranch(projectRow) : null;
  const branch =
    named && named !== issueRows[0]?.baseBranch && named !== excludedLive ? named : null;

  return {
    implementationJobCount: jobRows.length,
    handoffCommitSha,
    handoffFilesModified,
    branch,
  };
}

export function hasCodeEvidence(evidence: WorkEvidence): boolean {
  return (
    Boolean(evidence.handoffCommitSha) ||
    evidence.handoffFilesModified > 0 ||
    Boolean(evidence.branch)
  );
}

export async function hasChildIssues(
  issueId: string,
  executor: EvidenceExecutor = db,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: issueDependencies.id })
    .from(issueDependencies)
    .where(
      and(
        eq(issueDependencies.fromIssueId, issueId),
        eq(issueDependencies.kind, WORK_EVIDENCE_WAIVER_KIND),
        or(isNull(issueDependencies.validUntil), gt(issueDependencies.validUntil, sql`now()`)),
      ),
    )
    .limit(1);
  return row != null;
}

export const NO_WORK_EVIDENCE_DETAIL =
  'no branch, commit or code handoff is recorded for this issue — record the branch in ' +
  'sessionContext.branch or sessionContext.worklog.branch, or write the implementation step ' +
  'handoff with commitSha/filesModified, before advancing. A branch equal to the project base ' +
  'branch is not evidence, and neither is the live branch on a project whose releaseModel is ' +
  '`promote`: both name where work lands, not that any happened. On a `none` or `publish` ' +
  'project the live branch is not read at all, so a branch of that name counts like any other';

/**
 * The same check, letting its own failure out.
 *
 * ISS-1072: a reader that PUBLISHES this answer cannot use the fail-open one
 * below. "The query raised" and "the evidence is there" are the same value to
 * that caller, and a check run saying a criterion is met because a SELECT threw
 * is the silent substitution this repo forbids — worse here than in the gate,
 * because the gate's answer is seen by the one agent it refused and this one is
 * published on a pull request. Enforcement keeps the fail-open wrapper; nothing
 * that gates a transition may reach this.
 */
export async function missingWorkEvidenceStrict(
  issueId: string,
  executor: EvidenceExecutor = db,
): Promise<string | null> {
  if (await hasChildIssues(issueId, executor)) return null;
  const evidence = await collectWorkEvidence(issueId, executor);
  return hasCodeEvidence(evidence) ? null : NO_WORK_EVIDENCE_DETAIL;
}

export async function findMissingWorkEvidence(
  issueId: string,
  executor: EvidenceExecutor = db,
): Promise<string | null> {
  try {
    return await missingWorkEvidenceStrict(issueId, executor);
  } catch (err) {
    logger.warn({ err, issueId }, 'work-evidence: check failed, allowing (fail open)');
    return null;
  }
}
