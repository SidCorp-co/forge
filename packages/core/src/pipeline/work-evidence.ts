import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
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
import {
  DECLARE_OUTSIDE_GIT,
  type Lane,
  laneOrNull,
  whereItLands,
} from '../issues/landing-evidence.js';
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
  /** `issues.merged_landing` where a mark stands on an `outside_git` lane: where the work now is,
   *  that lane's own record of having landed. Null on a `git` lane, which records a commit. */
  mergedLanding: string | null;
  /** The commit a standing mark claims and Forge could not check (ISS-1409), counted like a branch. */
  claimedCommit: string | null;
  /** Where this issue's work lands, which decides the routes a refusal may offer; null where the
   *  issue declares nothing and the project's kind is none Forge knows. */
  lane: Lane | null;
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
        mergedLanding: issues.mergedLanding,
        mergedClaimedCommit: issues.mergedClaimedCommit,
        declaredLandingShape: issues.declaredLandingShape,
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

  const lane = laneOrNull(projectRow?.declaredLandingShape, projectRow?.projectKind);
  const marked = projectRow?.mergedAt != null;
  return {
    implementationJobCount: jobRows.length,
    handoffCommitSha,
    handoffFilesModified,
    branch,
    mergedCommitSha: marked ? projectRow?.mergedCommitSha?.trim() || null : null,
    mergedLanding:
      marked && lane?.shape === 'outside_git' ? projectRow?.mergedLanding?.trim() || null : null,
    claimedCommit: marked ? projectRow?.mergedClaimedCommit?.trim() || null : null,
    lane,
  };
}

/** Whether anything shows work happened: a branch, a handoff, a merge Forge read, the commit a mark
 *  claims where Forge could not read the repository, or — on an `outside_git` lane — the landing its
 *  mark names. */
export function hasCodeEvidence(evidence: WorkEvidence): boolean {
  return (
    Boolean(evidence.handoffCommitSha) ||
    evidence.handoffFilesModified > 0 ||
    Boolean(evidence.branch) ||
    Boolean(evidence.mergedCommitSha) ||
    Boolean(evidence.claimedCommit) ||
    Boolean(evidence.mergedLanding)
  );
}

/**
 * The unverified claim a standing mark holds, or null. Unlike `collectWorkEvidence`, which fails
 * open for a gate, a read that raised is raised: what a mark does with a claim turns on this answer.
 */
export async function readStandingClaim(
  issueId: string,
  executor: EvidenceExecutor = db,
): Promise<string | null> {
  const [row] = await executor
    .select({ claimed: issues.mergedClaimedCommit })
    .from(issues)
    .where(and(eq(issues.id, issueId), isNotNull(issues.mergedAt)))
    .limit(1);
  return row?.claimed?.trim() || null;
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

/** Which door the refusal answers: an agent's move at the agent-only gate (`advance`), an agent's
 *  mark with nothing behind it (`mark`, `merge-marker.ts:agentEvidence`), or a project-declared
 *  `work_evidence` entry criterion, which holds anyone, a person included (`criterion`). */
export type EvidenceDoor = 'advance' | 'mark' | 'criterion';

/** What the refused caller does once the evidence is recorded, at each door. */
const THEN: Readonly<Record<EvidenceDoor, string>> = {
  advance: 'before advancing',
  mark: 'then mark it again',
  criterion: 'before this status',
};

const DECLARED =
  'This check holds a person as well as an agent because the project declares it in ' +
  "`statusEntryCriteria`; where this project's work leaves none of these, that declaration is " +
  'what to change.';

/** Where Forge cannot verify the agent's commit it still counts, as a claim; where it read the repository and the repository says no, it does not. */
const UNREADABLE_REPOSITORY =
  "Where Forge cannot verify the commit (the project gives it no way to read its repository, the reader it has fails, or no base branch is named), that mark is accepted and the commit is recorded as a claim Forge has not verified, which counts as the evidence, and the mark says why and what would verify it; a repository Forge read that does not hold the commit as this issue's landing still refuses it.";

const WHERE_IT_NOW_IS =
  'where the work now is (the live URL, the deployment, the CMS entry or storefront resource)';

const UNKNOWN_LANE =
  "This project's kind is none of " +
  projectKinds.map((k) => `\`${k}\``).join(', ') +
  ', so whether its work lands in git is unknown and the commit route is not offered.';

/** Outside git the landing a mark names is the route, for anyone. A branch is that lane's second
 *  route and its base-branch paragraph is a git lane's, so the sentence ends on the lane. */
function outsideGitDetail(lane: Lane, door: EvidenceDoor): string {
  const lands = `${whereItLands(lane, true)}, so a commit is not read here.`;
  if (door === 'mark') {
    return (
      'this mark names no landing, and no branch or code handoff is recorded for this issue, so ' +
      'nothing was marked — mark it again with `mark_merged` carrying `data.landing`, ' +
      `${WHERE_IT_NOW_IS}. ${lands}`
    );
  }
  return (
    'no landing, branch or code handoff is recorded for this issue — mark it merged with ' +
    `\`mark_merged\` carrying \`data.landing\`, ${WHERE_IT_NOW_IS}, or ${BRANCH_OR_HANDOFF}, ` +
    `${THEN[door]}. ${lands}${door === 'criterion' ? ` ${DECLARED}` : ''}`
  );
}

/** On a git lane the commit route is read for an agent alone (`merge-marker.ts:applyMergeMarker`),
 *  so a sentence offering it to anyone else sends them into the same refusal again. */
function gitDetail(door: EvidenceDoor): string {
  if (door === 'mark') {
    return (
      'this mark names no commit, and no branch or code handoff is recorded for this issue, so ' +
      `nothing was marked — ${BRANCH_OR_HANDOFF}, then mark it again; or, where the work landed ` +
      'on the base branch itself, mark it again with `mark_merged` carrying `data.commit`, the ' +
      "commit it landed at, which Forge checks against the project's repository. " +
      `${UNREADABLE_REPOSITORY} ${DECLARE_OUTSIDE_GIT} ${NOT_A_BRANCH}`
    );
  }
  if (door === 'advance') {
    return (
      'no branch, commit or code handoff is recorded for this issue — record the branch in ' +
      'sessionContext.branch or sessionContext.worklog.branch, write the implementation step ' +
      'handoff with commitSha/filesModified, or, where the work landed on the base branch ' +
      'itself, mark it merged with `mark_merged` carrying `data.commit`, the commit it landed ' +
      `at, which Forge checks against the project's repository, before advancing. ` +
      `${UNREADABLE_REPOSITORY} ${DECLARE_OUTSIDE_GIT} ${NOT_A_BRANCH}`
    );
  }
  return (
    `no branch, commit or code handoff is recorded for this issue — ${BRANCH_OR_HANDOFF}, ` +
    'before this status. A merge mark counts only where Forge read its commit itself, or held it as a claim it could not check: a mark ' +
    "over a merged pull request Forge holds for this issue, or an agent's `mark_merged` " +
    "carrying `data.commit`, which Forge reads from the project's repository as this issue's " +
    'landing, or, where Forge cannot verify it, as the unverified ' +
    "claim that mark records; a person's mark naming a commit is checked only for the repository " +
    `holding it, not read as this issue's landing, so it does not clear this. ${DECLARE_OUTSIDE_GIT} ` +
    `${DECLARED} ${NOT_A_BRANCH}`
  );
}

/** The `NO_WORK_EVIDENCE` refusal, naming only the routes that clear it on this issue's lane at
 *  this door. */
export function noWorkEvidenceDetail(lane: Lane | null, door: EvidenceDoor = 'advance'): string {
  if (lane?.shape === 'outside_git') return outsideGitDetail(lane, door);
  if (lane?.shape === 'git') return gitDetail(door);
  return (
    `no branch or code handoff is recorded for this issue${door === 'mark' ? ', so nothing was marked' : ''} ` +
    `— ${BRANCH_OR_HANDOFF}, ${THEN[door]}. ${UNKNOWN_LANE}` +
    `${door === 'criterion' ? ` ${DECLARED}` : ''} ${NOT_A_BRANCH}`
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
  door: EvidenceDoor = 'advance',
): Promise<string | null> {
  if (await hasChildIssues(issueId, executor)) return null;
  const evidence = await collectWorkEvidence(issueId, executor);
  return hasCodeEvidence(evidence) ? null : noWorkEvidenceDetail(evidence.lane, door);
}

export async function findMissingWorkEvidence(
  issueId: string,
  executor: EvidenceExecutor = db,
  door: EvidenceDoor = 'advance',
): Promise<string | null> {
  try {
    return await missingWorkEvidenceStrict(issueId, executor, door);
  } catch (err) {
    logger.warn({ err, issueId }, 'work-evidence: check failed, allowing (fail open)');
    return null;
  }
}
