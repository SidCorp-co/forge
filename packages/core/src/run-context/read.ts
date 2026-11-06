import {
  RUN_CONTEXT_READ_LIMIT,
  type RunContextQuery,
  type RunContextView,
} from '@forge/contracts/run-context';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { runContextReaches as r } from '../db/schema-run-context.js';
import { runContextTally } from './record.js';

/**
 * What a run session, or every run over an issue, was given in a project: each reach in the order it
 * was recorded, at most `RUN_CONTEXT_READ_LIMIT`, and how many reaches this process could not record.
 */
export async function readRunContext(
  projectId: string,
  query: RunContextQuery,
): Promise<RunContextView> {
  const subject = query.session ? { session: query.session } : { issue: query.issue as string };
  const scope =
    'session' in subject ? eq(r.agentSessionId, subject.session) : eq(r.issueId, subject.issue);
  const rows = await db
    .select({
      kind: r.kind,
      ref: r.ref,
      revision: r.revision,
      how: r.how,
      sessionId: r.agentSessionId,
      issueId: r.issueId,
      at: r.createdAt,
    })
    .from(r)
    .where(and(eq(r.projectId, projectId), scope))
    .orderBy(asc(r.createdAt), asc(r.kind), asc(r.ref))
    .limit(RUN_CONTEXT_READ_LIMIT + 1);
  return {
    subject,
    reached: rows.slice(0, RUN_CONTEXT_READ_LIMIT).map((row) => ({
      ...row,
      at: row.at.toISOString(),
    })),
    truncated: rows.length > RUN_CONTEXT_READ_LIMIT,
    unrecorded: runContextTally(),
  };
}
