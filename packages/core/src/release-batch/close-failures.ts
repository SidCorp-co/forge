// Each close a finish could not make, kept on that release's own run
// (`pipeline_runs.metadata.closeFailures[issueId]`): the next finish reads it to say a repeat in
// the comment already there, and the roster reads it to say what Release now will meet (ISS-1381 r4).

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments } from '../db/schema.js';

export interface CloseFailureRecord {
  /** `refused` names a rule the issue broke; `failed` reached no decision. */
  kind: 'refused' | 'failed';
  /** The reason the finish answer carries for this issue (`closeFailureText`). */
  reason: string;
  version: string | null;
  /** The comment that says it, which a repeat rewrites. */
  commentId: string | null;
  /** Earlier releases whose finish failed this close for the same reason, oldest first. */
  repeats: Array<string | null>;
  at: string;
}

function recordOf(raw: unknown): CloseFailureRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if ((r.kind !== 'refused' && r.kind !== 'failed') || typeof r.reason !== 'string') return null;
  return {
    kind: r.kind,
    reason: r.reason,
    version: typeof r.version === 'string' ? r.version : null,
    commentId: typeof r.commentId === 'string' ? r.commentId : null,
    repeats: Array.isArray(r.repeats)
      ? r.repeats.map((v) => (typeof v === 'string' ? v : null))
      : [],
    at: typeof r.at === 'string' ? r.at : '',
  };
}

/** The latest close failure each issue carries on any release run of the project, and that run. */
export async function lastCloseFailures(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, CloseFailureRecord & { runId: string }>> {
  const out = new Map<string, CloseFailureRecord & { runId: string }>();
  if (issueIds.length === 0) return out;
  const rows = await db.execute<{ issue_id: string; record: unknown; run_id: string }>(sql`
    SELECT DISTINCT ON (f.key) f.key AS issue_id, f.value AS record, r.id AS run_id
      FROM pipeline_runs r
      CROSS JOIN LATERAL jsonb_each(r.metadata -> 'closeFailures') AS f(key, value)
     WHERE r.project_id = ${projectId}
       AND jsonb_typeof(r.metadata -> 'closeFailures') = 'object'
       AND f.key IN (${sql.join(
         issueIds.map((id) => sql`${id}`),
         sql`, `,
       )})
     ORDER BY f.key, f.value ->> 'at' DESC, r.created_at DESC
  `);
  for (const row of rows) {
    const record = recordOf(row.record);
    if (record) out.set(row.issue_id, { ...record, runId: row.run_id });
  }
  return out;
}

/**
 * Say on the issue why this finish could not close it, and keep that on the run. Where the latest
 * earlier finish failed it the same way and its comment is still there, that comment is rewritten
 * naming this release too, so one cause reads as one comment however many releases meet it.
 */
export async function sayCloseFailure(args: {
  runId: string;
  projectId: string;
  issueId: string;
  authorId: string;
  kind: CloseFailureRecord['kind'];
  reason: string;
  version: string | null;
  body: (repeats: ReadonlyArray<string | null>) => string;
}): Promise<void> {
  const prior = (await lastCloseFailures(args.projectId, [args.issueId])).get(args.issueId);
  const same =
    prior?.commentId && prior.kind === args.kind && prior.reason === args.reason ? prior : null;
  // A recovery this run already wrote is said again, never counted as an earlier release.
  const repeats = !same
    ? []
    : same.runId === args.runId
      ? same.repeats
      : [...same.repeats, same.version];
  const body = args.body(repeats);
  let commentId: string | null = null;
  if (same?.commentId) {
    const [row] = await db
      .update(comments)
      .set({ body, updatedAt: sql`now()` })
      .where(and(eq(comments.id, same.commentId), eq(comments.issueId, args.issueId)))
      .returning({ id: comments.id });
    commentId = row?.id ?? null;
  }
  if (!commentId) {
    const [row] = await db
      .insert(comments)
      .values({ issueId: args.issueId, authorId: args.authorId, body })
      .returning({ id: comments.id });
    commentId = row?.id ?? null;
  }
  const record: CloseFailureRecord = {
    kind: args.kind,
    reason: args.reason,
    version: args.version,
    commentId,
    repeats,
    at: new Date().toISOString(),
  };
  await db.execute(sql`
    UPDATE pipeline_runs
       SET metadata = jsonb_set(
             coalesce(metadata, '{}'::jsonb),
             '{closeFailures}',
             coalesce(metadata -> 'closeFailures', '{}'::jsonb)
               || jsonb_build_object(${args.issueId}::text, ${JSON.stringify(record)}::jsonb)),
           updated_at = now()
     WHERE id = ${args.runId}
  `);
}
