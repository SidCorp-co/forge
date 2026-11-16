import {
  RUN_CONTEXT_READ_LIMIT,
  type RunContextQuery,
  type RunContextView,
} from '@forge/contracts/run-context';
import { and, asc, eq, gte, inArray, isNotNull, max } from 'drizzle-orm';
import { db } from '../db/client.js';
import { runContextReaches as r } from '../db/schema-run-context.js';
import { runContextTally } from './record.js';

/**
 * What a run session, or every run over an issue, was given in a project: each reach in the order it
 * was recorded, at most `RUN_CONTEXT_READ_LIMIT`, and how many reaches this process could not record.
 * A find hit opened outside any run (no session) is never a run's reach.
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
    .where(and(eq(r.projectId, projectId), isNotNull(r.agentSessionId), scope))
    .orderBy(asc(r.createdAt), asc(r.kind), asc(r.ref))
    .limit(RUN_CONTEXT_READ_LIMIT + 1);
  return {
    subject,
    reached: rows
      .slice(0, RUN_CONTEXT_READ_LIMIT)
      .flatMap(({ sessionId, ...row }) =>
        sessionId ? [{ ...row, sessionId, at: row.at.toISOString() }] : [],
      ),
    truncated: rows.length > RUN_CONTEXT_READ_LIMIT,
    unrecorded: runContextTally(),
  };
}

/**
 * When each of `slugs` was last opened by an agent session on its own (a knowledge get of it by its
 * slug, not a prompt that carried it nor a search that returned it), since `since` (ISS-1251): what
 * an agent reached for, which keeps a lesson in use where no `Lessons applied:` line named it.
 */
export async function lastOpenedOf(
  projectId: string,
  slugs: readonly string[],
  since: Date,
): Promise<Map<string, Date>> {
  if (slugs.length === 0) return new Map();
  const rows = await db
    .select({ ref: r.ref, at: max(r.createdAt) })
    .from(r)
    .where(
      and(
        eq(r.projectId, projectId),
        // an agent session's own open; a person's open outside any run keeps no lesson in use
        isNotNull(r.agentSessionId),
        eq(r.how, 'get'),
        inArray(r.ref, [...slugs]),
        gte(r.createdAt, since),
      ),
    )
    .groupBy(r.ref);
  return new Map(rows.flatMap((row) => (row.at ? [[row.ref, row.at] as const] : [])));
}
