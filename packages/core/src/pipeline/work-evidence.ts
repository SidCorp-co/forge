/**
 * ISS-786 Child B — evidence Forge already stores that code exists for an
 * issue. Core has no repo checkout (`git merge-base`/`is-ancestor` return
 * zero source hits under `packages/core/src`), so a real git check is
 * impossible server-side; this reads DB-side signals instead: the handoff of
 * a step that writes code (`commitSha` / `filesModified`, `issue_step_contexts`
 * `kind='handoff'`) and the direct-ship `sessionContext.branch` marker
 * (`state-machine.ts:80`). A done implementation job with an EMPTY handoff is
 * explicitly NOT evidence — that is precisely the ISS-105 fabrication shape,
 * so `implementationJobCount` alone never satisfies {@link hasCodeEvidence}.
 *
 * Shared by the `no_work_evidence` transition rule (`transition-evidence.ts`)
 * and the `mark_merged` MCP action (`mcp/tools/forge-issues.ts`) so both key
 * on identical evidence and an identical grouping-parent exemption.
 */

import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import { issueDependencies, issueStepContexts, issues, jobs, projects } from '../db/schema.js';
import { logger } from '../logger.js';

// cm:guard `drive` belongs in this list for the same reason `code` and `fix` do: it is a step that WRITES CODE, and its handoff schema carries `commitSha` — one of the two fields `hasCodeEvidence` reads (`drive` has no `filesModified`; `code` and `fix` carry both). It was absent until 2026-09-02, so an autonomous driver that merged its branch and wrote a correct handoff had no evidence at all: `applyMergeMarker` refused its own `POST /api/issues/:id/merge` with NO_WORK_EVIDENCE, and the close-stamp audit comment told every reader "no branch, commit or code handoff is recorded" on work that had all three. Measured the same day on forge-beta: 7 `drive` handoffs stored, 7 of them carrying a `commitSha`, 0 counted here.
// cm:edge lockstep -> packages/core/src/prompt/facts/registry.ts#HANDOFF_KEYS — a step whose handoff schema gains `commitSha`/`filesModified` is evidence of code and belongs here; one that loses them stops being evidence and must leave.
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
        productionBranch: projects.productionBranch,
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
  const named =
    sessionContext && typeof sessionContext.branch === 'string' && sessionContext.branch.length > 0
      ? sessionContext.branch
      : null;
  // cm:guard the project's OWN base or production branch is not evidence of work on THIS issue — it names where work lands, not that any happened, and it is the one string an agent can write truthfully while having done nothing. Measured on forge-dev 2026-09-02: 2 issues carried `branch: 'main'` (base AND production) with zero `code`/`fix`/`drive` jobs, satisfying the gate ISS-786 built to stop exactly that claim. 17 of the 112 issues holding a branch fleet-wide named their base or production branch.
  const branch =
    named && named !== issueRows[0]?.baseBranch && named !== issueRows[0]?.productionBranch
      ? named
      : null;

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
        eq(issueDependencies.kind, 'decomposes'),
        or(isNull(issueDependencies.validUntil), gt(issueDependencies.validUntil, sql`now()`)),
      ),
    )
    .limit(1);
  return row != null;
}

export const NO_WORK_EVIDENCE_DETAIL =
  'no branch, commit or code handoff is recorded for this issue — record the branch in ' +
  'sessionContext.branch or write the implementation step handoff with commitSha/filesModified ' +
  'before advancing';

// cm:guard fails OPEN on any internal error — a broken evidence check must never freeze a legitimate advance
export async function findMissingWorkEvidence(
  issueId: string,
  executor: EvidenceExecutor = db,
): Promise<string | null> {
  try {
    if (await hasChildIssues(issueId, executor)) return null;
    const evidence = await collectWorkEvidence(issueId, executor);
    if (hasCodeEvidence(evidence)) return null;
    return NO_WORK_EVIDENCE_DETAIL;
  } catch (err) {
    logger.warn({ err, issueId }, 'work-evidence: check failed, allowing (fail open)');
    return null;
  }
}
