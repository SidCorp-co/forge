import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import { issueStepContexts, issues, jobs, projects } from '../db/schema.js';
import { readLandingBranches } from './ports.js';

const IMPLEMENTATION_STEPS = ['code', 'fix', 'drive'] as const;

const JOB_SCAN_LIMIT = 50;
const HANDOFF_SCAN_LIMIT = 50;

type EvidenceExecutor = Pick<Db, 'select'>;

interface WorkEvidence {
  implementationJobCount: number;
  handoffCommitSha: string | null;
  handoffFilesModified: number;
  branch: string | null;
  /** `issues.merged_commit_sha`: a merge Forge read for itself, from a pull request or the repository. */
  mergedCommitSha: string | null;
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
        branch: sql<
          string | null
        >`(SELECT w.branch FROM issue_work_state w WHERE w.issue_id = ${issues.id})`,
        mergedAt: issues.mergedAt,
        mergedCommitSha: issues.mergedCommitSha,
        projectId: issues.projectId,
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

  // ISS-54 — the branch is the work state's typed column; a forge-plugin `sessionContext` write
  // naming `branch` or `worklog.branch` lands there (`work-state.ts:splitSessionContext`).
  const named = issueRows[0]?.branch?.trim() || undefined;
  const projectRow = issueRows[0];
  const { defaultBranch, promoted: excludedLive } = projectRow
    ? await readLandingBranches(projectRow.projectId)
    : { defaultBranch: null, promoted: null };
  const branch = named && named !== defaultBranch && named !== excludedLive ? named : null;

  return {
    implementationJobCount: jobRows.length,
    handoffCommitSha,
    handoffFilesModified,
    branch,
    mergedCommitSha:
      projectRow?.mergedAt != null ? projectRow.mergedCommitSha?.trim() || null : null,
  };
}

/**
 * The commit the newest implementation handoff names, among those written after `since` (all where
 * null); null where none does. A handoff is rewritten in place on a re-run of its attempt, so its
 * last write is when it was written.
 */
export async function latestHandoffCommit(
  issueId: string,
  since: Date | null,
  executor: EvidenceExecutor = db,
): Promise<string | null> {
  const rows = await executor
    .select({ commit: sql<string | null>`${issueStepContexts.payload} ->> 'commitSha'` })
    .from(issueStepContexts)
    .where(
      and(
        eq(issueStepContexts.issueId, issueId),
        eq(issueStepContexts.kind, 'handoff'),
        inArray(issueStepContexts.step, IMPLEMENTATION_STEPS),
        sql`coalesce(${issueStepContexts.payload} ->> 'commitSha', '') <> ''`,
        ...(since ? [gt(issueStepContexts.updatedAt, since)] : []),
      ),
    )
    .orderBy(desc(issueStepContexts.updatedAt), desc(issueStepContexts.id))
    .limit(1);
  return rows[0]?.commit ?? null;
}

/**
 * Each piece of code evidence the issue carries, named: what an adoption record may never stand in
 * for (REQ-5 BC-18), and what keeps a mark naming nothing from standing on approved designs
 * (`design-mark.ts`). It is never asked whether a mark may be written: a mark takes the agent's word
 * (ISS-1017). Strict — a reader that refuses on this answer cannot take a raised query for "no
 * code", so its failure is let out rather than read as none.
 */
export async function codeEvidenceOf(
  issueId: string,
  executor: EvidenceExecutor = db,
): Promise<string[]> {
  const e = await collectWorkEvidence(issueId, executor);
  return [
    e.handoffCommitSha ? `an implementation handoff naming commit ${e.handoffCommitSha}` : null,
    e.handoffFilesModified > 0
      ? `${e.handoffFilesModified} modified file(s) in its implementation handoffs`
      : null,
    e.branch ? `branch ${e.branch}` : null,
    e.mergedCommitSha ? `merged commit ${e.mergedCommitSha}` : null,
  ].filter((x): x is string => x !== null);
}
