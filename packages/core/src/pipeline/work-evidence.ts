import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import {
  issueDependencies,
  issueStepContexts,
  issues,
  jobs,
  projectKinds,
  projects,
} from '../db/schema.js';
import { WORK_EVIDENCE_WAIVER_KIND } from '../issues/dependency-effects.js';
import { type LandingShape, landingShapeOf } from '../issues/landing-evidence.js';
import { logger } from '../logger.js';
import { chainLiveBranch } from '../projects/release-chain.js';

const IMPLEMENTATION_STEPS = ['code', 'fix', 'drive'] as const;

const JOB_SCAN_LIMIT = 50;
const HANDOFF_SCAN_LIMIT = 50;

type EvidenceExecutor = Pick<Db, 'select'>;

export interface WorkEvidence {
  implementationJobCount: number;
  handoffCommitSha: string | null;
  handoffFilesModified: number;
  branch: string | null;
  /** `issues.merged_commit_sha`: a merge Forge read for itself, from a pull request or the repository. */
  mergedCommitSha: string | null;
  /** Where this project's work lands, which decides the routes a refusal may offer; null where
   *  the project's kind is none Forge knows. */
  lane: LandingShape | null;
}

function laneOf(kind: string | undefined): LandingShape | null {
  return kind !== undefined && (projectKinds as readonly string[]).includes(kind)
    ? landingShapeOf(kind)
    : null;
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
        mergedAt: issues.mergedAt,
        mergedCommitSha: issues.mergedCommitSha,
        baseBranch: projects.baseBranch,
        releaseChain: projects.releaseChain,
        projectKind: projects.kind,
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
  const excludedLive = projectRow ? chainLiveBranch(projectRow.releaseChain) : null;
  const branch =
    named && named !== issueRows[0]?.baseBranch && named !== excludedLive ? named : null;

  return {
    implementationJobCount: jobRows.length,
    handoffCommitSha,
    handoffFilesModified,
    branch,
    mergedCommitSha:
      projectRow?.mergedAt != null ? projectRow.mergedCommitSha?.trim() || null : null,
    lane: laneOf(projectRow?.projectKind),
  };
}

export function hasCodeEvidence(evidence: WorkEvidence): boolean {
  return (
    Boolean(evidence.handoffCommitSha) ||
    evidence.handoffFilesModified > 0 ||
    Boolean(evidence.branch) ||
    Boolean(evidence.mergedCommitSha)
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

const BRANCH_OR_HANDOFF =
  'record the branch in sessionContext.branch or sessionContext.worklog.branch, or write the ' +
  'implementation step handoff with commitSha/filesModified';

const NOT_A_BRANCH =
  'A branch equal to the project base branch is not evidence, and neither is the last branch of ' +
  'a project whose release chain has two or more entries: both name where work lands, not that ' +
  'any happened. Where the chain is empty or names one branch there is no live branch to ' +
  'exclude, so a branch of that name counts like any other';

/**
 * The `NO_WORK_EVIDENCE` refusal, naming only the routes that clear it on this project's lane:
 * the commit route is read on a `git` project alone (`merge-marker.ts:applyMergeMarker`), so a
 * sentence offering it anywhere else sends the caller into the same refusal again.
 */
export function noWorkEvidenceDetail(lane: LandingShape | null): string {
  if (lane === 'git') {
    return (
      'no branch, commit or code handoff is recorded for this issue — record the branch in ' +
      'sessionContext.branch or sessionContext.worklog.branch, write the implementation step ' +
      'handoff with commitSha/filesModified, or, where the work landed on the base branch ' +
      'itself, mark it merged with `mark_merged` carrying `data.commit`, the commit it landed ' +
      `at, which Forge checks against the project's repository, before advancing. ${NOT_A_BRANCH}`
    );
  }
  const why =
    lane === 'outside_git'
      ? "This project's work lands outside git (kind `website`), so a commit sent with " +
        '`mark_merged` is not read here, and a landing it names is not evidence for an agent: ' +
        'where neither route above is open, a person may mark it merged and move it, which ' +
        'this check does not hold them to.'
      : "This project's kind is none of " +
        projectKinds.map((k) => `\`${k}\``).join(', ') +
        ', so whether its work lands in git is unknown and the commit route is not offered.';
  return (
    `no branch or code handoff is recorded for this issue — ${BRANCH_OR_HANDOFF}, before ` +
    `advancing. ${why} ${NOT_A_BRANCH}`
  );
}

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
  return hasCodeEvidence(evidence) ? null : noWorkEvidenceDetail(evidence.lane);
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
