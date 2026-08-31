/**
 * UX findings — the per-issue record an agent writes when it sees a contract
 * rule broken, and the list a reviewer reads back.
 *
 * Written only through `forge_ux_findings` today; the queries live here so the
 * next surface that needs them does not grow a second copy.
 */

import { and, count, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  issues,
  type UxFindingKind,
  type UxFindingStage,
  uxContractRules,
  uxFindings,
} from '../db/schema.js';

/** Does this issue exist in this project? */
export async function issueBelongsToProject(issueId: string, projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.projectId, projectId)))
    .limit(1);
  return row !== undefined;
}

// cm:guard `runId` is NULL on the explicit-issueId path, and `eq(col, null)` is SQL NULL — never true — so matching with `eq` makes the caller's cap silently stop capping. Use isNull, or an agent looping on the explicit-issue escape hatch writes unbounded rows.
export async function countFindingsFor(issueId: string, runId: string | null): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(uxFindings)
    .where(
      and(
        eq(uxFindings.issueId, issueId),
        runId === null ? isNull(uxFindings.runId) : eq(uxFindings.runId, runId),
      ),
    )
    .limit(1);
  return Number(row?.n ?? 0);
}

/** The rule id if it belongs to this project, else `null`. */
export async function resolveProjectRuleId(
  ruleId: string,
  projectId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: uxContractRules.id })
    .from(uxContractRules)
    .where(and(eq(uxContractRules.id, ruleId), eq(uxContractRules.projectId, projectId)))
    .limit(1);
  return row?.id ?? null;
}

export type NewUxFinding = {
  projectId: string;
  issueId: string;
  runId: string | null;
  stage: UxFindingStage;
  ruleId: string | null;
  kind: UxFindingKind;
  detail: string;
  severity: 'must' | 'should';
};

export async function insertUxFinding(input: NewUxFinding): Promise<string> {
  const [row] = await db
    .insert(uxFindings)
    .values({
      projectId: input.projectId,
      issueId: input.issueId,
      runId: input.runId ?? undefined,
      stage: input.stage,
      ruleId: input.ruleId ?? undefined,
      kind: input.kind,
      detail: input.detail,
      severity: input.severity,
    })
    .returning({ id: uxFindings.id });
  if (!row) throw new Error('ux finding insert returned no row');
  return row.id;
}

export type UxFindingQuery = {
  projectId: string;
  issueId?: string | undefined;
  stage?: UxFindingStage | undefined;
  kind?: UxFindingKind | undefined;
  limit: number;
};

export async function listUxFindings(q: UxFindingQuery) {
  const conds: SQL[] = [eq(uxFindings.projectId, q.projectId)];
  if (q.issueId) conds.push(eq(uxFindings.issueId, q.issueId));
  if (q.stage) conds.push(eq(uxFindings.stage, q.stage));
  if (q.kind) conds.push(eq(uxFindings.kind, q.kind));

  return db
    .select({
      id: uxFindings.id,
      issueId: uxFindings.issueId,
      runId: uxFindings.runId,
      stage: uxFindings.stage,
      ruleId: uxFindings.ruleId,
      kind: uxFindings.kind,
      detail: uxFindings.detail,
      severity: uxFindings.severity,
      createdAt: uxFindings.createdAt,
    })
    .from(uxFindings)
    .where(and(...conds))
    .orderBy(desc(uxFindings.createdAt))
    .limit(q.limit);
}
