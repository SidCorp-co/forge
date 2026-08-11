/**
 * ISS-786 Child B — evidence Forge already stores that code exists for an
 * issue. Core has no repo checkout (`git merge-base`/`is-ancestor` return
 * zero source hits under `packages/core/src`), so a real git check is
 * impossible server-side; this reads DB-side signals instead: the `code`/
 * `fix` step handoff (`commitSha` / `filesModified`, `issue_step_contexts`
 * `kind='handoff'`) and the direct-ship `sessionContext.branch` marker
 * (`state-machine.ts:80`). A done `code`/`fix` job with an EMPTY handoff is
 * explicitly NOT evidence — that is precisely the ISS-105 fabrication shape,
 * so `implementationJobCount` alone never satisfies {@link hasCodeEvidence}.
 *
 * Shared by the `no_work_evidence` transition rule (`transition-evidence.ts`)
 * and the `mark_merged` MCP action (`mcp/tools/forge-issues.ts`) so both key
 * on identical evidence and an identical decompose-parent exemption.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueDependencies, issueStepContexts, issues, jobs } from '../db/schema.js';
import { logger } from '../logger.js';

/** Bounded scan limits — informational fields only, never gate correctness. */
const JOB_SCAN_LIMIT = 50;
const HANDOFF_SCAN_LIMIT = 50;

export interface WorkEvidence {
  implementationJobCount: number;
  handoffCommitSha: string | null;
  handoffFilesModified: number;
  branch: string | null;
}

/**
 * Gather every in-DB signal that code exists for `issueId`. Does NOT catch —
 * callers fold this into their own fail-open handling (see
 * {@link findMissingWorkEvidence}).
 */
export async function collectWorkEvidence(issueId: string): Promise<WorkEvidence> {
  const [jobRows, handoffRows, issueRows] = await Promise.all([
    db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.issueId, issueId), inArray(jobs.type, ['code', 'fix'])))
      .limit(JOB_SCAN_LIMIT),
    db
      .select({ payload: issueStepContexts.payload })
      .from(issueStepContexts)
      .where(
        and(
          eq(issueStepContexts.issueId, issueId),
          eq(issueStepContexts.kind, 'handoff'),
          inArray(issueStepContexts.step, ['code', 'fix']),
        ),
      )
      .limit(HANDOFF_SCAN_LIMIT),
    db
      .select({ sessionContext: issues.sessionContext })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1),
  ]);

  // Aggregate across every recorded code/fix handoff (not just the latest) —
  // a real commit/files claim persists even if a later attempt's handoff is
  // empty (e.g. a no-op fix pass after the real work already landed).
  let handoffCommitSha: string | null = null;
  let handoffFilesModified = 0;
  for (const row of handoffRows) {
    // Stored payload is validated at write time against the discriminated
    // `stepHandoffSchema` union (only `code` carries `commitSha`; `code`/
    // `fix` both carry `filesModified`) but read back as opaque jsonb — treat
    // it as an untyped record here rather than importing the write-side type.
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
  const branch =
    sessionContext && typeof sessionContext.branch === 'string' && sessionContext.branch.length > 0
      ? sessionContext.branch
      : null;

  return {
    implementationJobCount: jobRows.length,
    handoffCommitSha,
    handoffFilesModified,
    branch,
  };
}

/** A bare done `code`/`fix` job (`implementationJobCount`) is deliberately NOT evidence. */
export function hasCodeEvidence(evidence: WorkEvidence): boolean {
  return (
    Boolean(evidence.handoffCommitSha) ||
    evidence.handoffFilesModified > 0 ||
    Boolean(evidence.branch)
  );
}

/**
 * Decompose parents legitimately reach claiming statuses with no branch of
 * their own — their children carry the code (`issue_dependencies` outgoing
 * `kind='decomposes'` edge).
 */
export async function isDecomposeParent(issueId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: issueDependencies.id })
    .from(issueDependencies)
    .where(
      and(eq(issueDependencies.fromIssueId, issueId), eq(issueDependencies.kind, 'decomposes')),
    )
    .limit(1);
  return row != null;
}

export const NO_WORK_EVIDENCE_DETAIL =
  'no branch, commit or code handoff is recorded for this issue — record the branch in ' +
  'sessionContext.branch or write the code/fix step handoff with commitSha/filesModified ' +
  'before advancing';

/**
 * `null` = no violation (evidence found, or the issue is a decompose parent).
 * A string = the refusal detail to surface to the caller.
 */
// cm:guard fails OPEN on any internal error — a broken evidence check must never freeze a legitimate advance
export async function findMissingWorkEvidence(issueId: string): Promise<string | null> {
  try {
    if (await isDecomposeParent(issueId)) return null;
    const evidence = await collectWorkEvidence(issueId);
    if (hasCodeEvidence(evidence)) return null;
    return NO_WORK_EVIDENCE_DETAIL;
  } catch (err) {
    logger.warn({ err, issueId }, 'work-evidence: check failed, allowing (fail open)');
    return null;
  }
}
