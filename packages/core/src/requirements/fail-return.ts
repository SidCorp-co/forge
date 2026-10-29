/**
 * The way back from a requirement-level fail's reopen (ISS-760, issue-lifecycle revision 23): how
 * that fail would route the issue were it back at the status it was reopened from now. The reading
 * is the one the fail itself is routed by (`verdicts.ts:routeFail` over the BC's coverage,
 * `standing-read.ts:standingsOf`), with the issue read as back: at that status, and its reopen
 * undone, so the verdicts it voided count as they did at its landing. The issue kernel asks it
 * through its port (`issues/ports.ts:requirementFailReturn`) and refuses the move by name.
 */

import { requirementKey } from '@forge/contracts/requirements';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { requirements } from '../db/schema-requirements.js';
import { issueDisplayIds, type RequirementFailReturn } from '../issues/index.js';
import { standingsOf } from './standing-read.js';
import { deliversItsHalf, routeFail, tracingIssuesOf } from './verdicts.js';

export async function requirementFailReturn(args: {
  projectId: string;
  issueId: string;
  verdictId: string;
  status: IssueStatus;
}): Promise<RequirementFailReturn> {
  const [fail] = (await db.execute(sql`
    SELECT v.requirement_id, v.reason, rc.code
      FROM requirement_criterion_verdicts v
      JOIN requirements r ON r.id = v.requirement_id
      JOIN requirement_criteria rc ON rc.id = v.requirement_criterion_id
     WHERE v.id = ${args.verdictId}::uuid AND v.verdict = 'fail' AND r.project_id = ${args.projectId}
  `)) as unknown as Array<{ requirement_id: string; reason: string | null; code: string }>;
  if (!fail) return { kind: 'none' };
  const [row] = await db
    .select()
    .from(requirements)
    .where(eq(requirements.id, fail.requirement_id));
  if (!row) return { kind: 'none' };
  const bc = `${requirementKey(row.reqSeq)} ${fail.code}`;
  const coverage = (
    await standingsOf(args.projectId, [row], null, undefined, { asReturned: [args.issueId] })
  )
    .get(row.id)
    ?.coverage.find((c) => c.code === fail.code);
  const tracing = await tracingIssuesOf(db, row.id, fail.code, {
    issueId: args.issueId,
    status: args.status,
  });
  const keys = await issueDisplayIds(tracing.map((i) => i.id));
  const mine = routeFail(bc, tracing, keys, coverage).find((r) => r.issueId === args.issueId);
  const links = coverage?.issues.filter((l) => l.issueId === args.issueId) ?? [];
  const notPassing = links
    .filter((l) => l.stale || l.verdict !== 'pass' || l.notCounted !== null)
    .map((l) => ({
      criterion: l.criterion,
      verdict: l.verdict,
      why: l.stale ? 'it traces an earlier wording of the BC' : l.notCounted,
    }));
  return {
    kind: 'read',
    bc,
    reason: fail.reason?.trim() || null,
    delivers: deliversItsHalf(args.issueId, coverage),
    outcome: mine?.outcome ?? 'reopen',
    why: mine?.why ?? `it traces ${bc} no longer`,
    notPassing,
  };
}
