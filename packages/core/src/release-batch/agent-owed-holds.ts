// The release holds a project's master owes the act of (ISS-888): read for its owed work
// (`masters/owed.ts`), so a hold naming the agent's act is never written and left unread.

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { releaseHolds } from '../db/schema-release-ledger.js';
import { issueDisplayIds, releaseHoldWords, waitingForReleaseSql } from '../issues/index.js';

/** A standing hold whose act is the agent's: the issue it holds and what it waits for. */
export interface AgentOwedHold {
  issueId: string;
  key: string;
  code: string;
  waitingFor: string;
}

/**
 * Every standing hold on this project's waiting rows whose act is its agent's (ISS-888): owed by the
 * agent, and not one the release path clears by itself (`release-hold-words.ts`, actor `release`),
 * such as a row queued behind a full roster. The master is told each, so no hold names an act
 * nobody reads.
 */
export async function agentOwedHolds(projectId: string): Promise<AgentOwedHold[]> {
  const rows = await db
    .select({
      issueId: releaseHolds.issueId,
      code: releaseHolds.code,
      owes: releaseHolds.owes,
      waitingFor: releaseHolds.waitingFor,
    })
    .from(releaseHolds)
    .innerJoin(issues, eq(issues.id, releaseHolds.issueId))
    .where(
      and(
        eq(releaseHolds.projectId, projectId),
        isNull(releaseHolds.clearedAt),
        eq(releaseHolds.owes, 'agent'),
        waitingForReleaseSql(sql`${issues}`),
        isNull(issues.releaseBatchRunId),
      ),
    )
    .orderBy(asc(releaseHolds.heldAt), asc(releaseHolds.issueId));
  // the abort of an ended run is named once, by its run with every issue it holds (`ended-claims.ts`)
  const owed = rows.filter(
    (r) => releaseHoldWords(r).actor !== 'release' && r.code !== 'RELEASE_HELD_BY_ENDED_RUN',
  );
  const keys = await issueDisplayIds(owed.map((r) => r.issueId));
  return owed.map((r) => ({
    issueId: r.issueId,
    key: keys.get(r.issueId) ?? r.issueId,
    code: r.code,
    waitingFor: r.waitingFor,
  }));
}
