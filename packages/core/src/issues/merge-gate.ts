import { and, isNull, or, type SQL, sql } from 'drizzle-orm';
import { issues } from '../db/schema.js';
import { evidenceFreeMarkSql } from './mark-trail.js';

/**
 * The WHERE a merge stamp writes under (`merge-record.ts:recordIssueMerge`). A mark is first-wins,
 * except where it amends a standing mark naming no evidence (ISS-1345). A later host merge of
 * another commit supersedes what the row holds (REQ-63: the last request delivering an issue is its
 * landing); every other observed stamp is first-wins.
 */
export function stampGate(args: {
  evidence: { kind: string; commitSha?: string };
  hostMerge: unknown;
  amends: boolean;
  stampExpr: SQL;
}): SQL | undefined {
  const { evidence, hostMerge, amends, stampExpr } = args;
  if (evidence.kind !== 'observed') {
    return amends
      ? or(isNull(issues.mergedAt), evidenceFreeMarkSql(sql`${issues}`))
      : isNull(issues.mergedAt);
  }
  if (!hostMerge) return isNull(issues.mergedCommitSha);
  return or(
    isNull(issues.mergedCommitSha),
    and(
      sql`${issues.mergedAt} < ${stampExpr}`,
      sql`lower(${issues.mergedCommitSha}) <> ${(evidence.commitSha ?? '').toLowerCase()}`,
    ),
  );
}
