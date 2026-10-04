import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import { eq, type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { emitEvent } from '../outbox/index.js';

export type IssueTriage = Partial<
  Pick<typeof issues.$inferInsert, 'priority' | 'category' | 'complexity'>
>;

/** An accepted triage sets the fields it names and no other. */
export async function setIssueTriage(tx: Tx, issueId: string, set: IssueTriage): Promise<void> {
  if (Object.keys(set).length === 0) return;
  await tx
    .update(issues)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(issues.id, issueId));
}

/** A batch edit's plain fields, stamped with the database clock, and its `issue.updated` event. */
export async function applyBatchFieldEdit(
  issue: { id: string; projectId: string },
  set: IssueTriage,
  change: Omit<OutboxEventPayload<'issue.updated'>, 'issueId' | 'projectId'>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(issues)
      .set({ ...set, updatedAt: sql`now()` })
      .where(eq(issues.id, issue.id));
    await emitEvent(tx, 'issue.updated', {
      issueId: issue.id,
      projectId: issue.projectId,
      ...change,
    });
  });
}

/**
 * Replace an issue's metadata with `next`, an expression over the stored `metadata` (a merge or a
 * `jsonb_set`), so a writer that owns one key leaves the others as they stand.
 */
export async function rewriteIssueMetadata(issueId: string, next: SQL, tx: Tx = db): Promise<void> {
  await tx.update(issues).set({ metadata: next }).where(eq(issues.id, issueId));
}

/**
 * When a person first started the issue's run, kept on a second start so the clock is not reset.
 * Null when the issue is gone.
 */
export async function stampRunStarted(issueId: string): Promise<string | null> {
  const rows = (await db.execute(sql`
    UPDATE issues
    SET session_context = CASE
          WHEN session_context ? 'runRelease' THEN session_context
          ELSE jsonb_set(COALESCE(session_context, '{}'::jsonb), ARRAY['runRelease'], to_jsonb(now()), true)
        END,
        updated_at = CASE WHEN session_context ? 'runRelease' THEN updated_at ELSE now() END
    WHERE id = ${issueId}
    RETURNING session_context->>'runRelease' AS started_at
  `)) as unknown as Array<{ started_at: string }>;
  return rows[0]?.started_at ?? null;
}

/**
 * A detector files its issue, once per external id: null when another delivery already filed it.
 * The row carries only what a detector may decide; priority, category and labels take their
 * defaults.
 */
export async function fileDetectedIssue(row: {
  projectId: string;
  title: string;
  description: string;
  createdById: string;
  source: string;
  externalId: string;
  detectorKey: string;
  status: 'draft';
  metadata: Record<string, unknown>;
  scheduleRunId: string | null;
}): Promise<string | null> {
  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, description, created_by_id, source, external_id, detector_key, status, created_via, metadata, schedule_run_id)
    VALUES (${row.projectId}, ${row.title}, ${row.description}, ${row.createdById}, ${row.source}, ${row.externalId}, ${row.detectorKey}, ${row.status}, 'system', ${JSON.stringify(row.metadata)}::jsonb, ${row.scheduleRunId})
    ON CONFLICT (project_id, source, external_id) WHERE external_id IS NOT NULL DO NOTHING
    RETURNING id
  `);
  return (inserted[0] as { id?: string } | undefined)?.id ?? null;
}
