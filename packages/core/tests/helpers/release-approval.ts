import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { createTestIssue, rows } from './factories.js';

/**
 * A release run cut as `version` on `projectId`, carrying one landed issue (numbered from the
 * version's minor), its approval asked by `askedBy`.
 */
export async function cutAndAsk(
  projectId: string,
  askedBy: string,
  version: string,
): Promise<{ runId: string; approvalId: string }> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, metadata)
    VALUES (${id}, ${projectId}, 'system', 'running', now(), ${version},
            ${JSON.stringify({ source: 'release-batch', issueIds: [] })}::jsonb)`);
  const at = new Date();
  const issue = await createTestIssue(projectId, askedBy, 9000 + Number(version.split('.')[1]), {
    status: 'awaiting_release',
    createdAt: at,
    mergedAt: at,
  });
  await db.execute(sql`
    UPDATE issues SET release_batch_run_id = ${id} WHERE id = ${issue.id}`);
  await db.execute(sql`
    UPDATE pipeline_runs SET metadata = ${JSON.stringify({ source: 'release-batch', issueIds: [issue.id] })}::jsonb
     WHERE id = ${id}`);
  const [asked] = await rows<{ id: string }>(sql`
    INSERT INTO release_approvals (project_id, run_id, requested_by_user, evidence_commit, evidence_reading)
    VALUES (${projectId}, ${id}, ${askedBy}, ${'c'.repeat(40)}, 'served on staging')
    RETURNING id`);
  return { runId: id, approvalId: String(asked?.id) };
}

/** A release approval as it stands: its decision, who decided it, and the reason recorded. */
export const approvalOf = async (id: string) =>
  (
    await rows<{ decision: string | null; decided_by_user: string | null; reason: string | null }>(
      sql`SELECT decision, decided_by_user, reason FROM release_approvals WHERE id = ${id}`,
    )
  )[0];
