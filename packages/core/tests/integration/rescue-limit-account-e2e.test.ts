/**
 * ISS-1228 round 20 (judge-62) — the rescue limit parked an issue at Needs info with a comment saying
 * its agent "finished without an error" and that "0 agent sessions" worked it, beside four failed
 * sessions on its run. The comment now counts the run's sessions off their rows.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
});

async function cappedRun(sessionStatuses: readonly string[]): Promise<string> {
  const issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 2, 'Scratch issue 2', 'open', ${ownerId})
  `);
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, metadata)
    VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running',
            '{"autonomousRescue":{"count":3,"doneDriveJobs":0}}'::jsonb)
  `);
  for (const status of sessionStatuses) {
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, kind, status)
      VALUES (${randomUUID()}, ${projectId}, ${runId}, 'pipeline', ${status})
    `);
  }
  return issueId;
}

async function park(issueId: string) {
  const { checkAutonomousRescueCap } = await import('../../src/pipeline/autonomous-rescue-cap.js');
  const capped = await checkAutonomousRescueCap({
    projectId,
    issueId,
    status: 'open',
    reopenCount: 0,
  });
  expect(capped.capped).toBe(true);
  const [issue] = await harness.db.execute<{ status: string }>(
    sql`SELECT status FROM issues WHERE id = ${issueId}`,
  );
  expect(issue?.status).toBe('needs_info');
  const rows = await harness.db.execute<{ body: string }>(
    sql`SELECT body FROM comments WHERE issue_id = ${issueId} AND body LIKE '%stopped sending%'`,
  );
  expect(rows).toHaveLength(1);
  return rows[0]?.body ?? '';
}

describe('the rescue limit says what the records say (criteria 190, 191)', () => {
  it('counts four failed sessions as four failed, never as an agent that finished cleanly', async () => {
    const body = await park(await cappedRun(['failed', 'failed', 'failed', 'failed']));
    expect(body).toContain('4 agent sessions worked this run: 4 failed.');
    expect(body).not.toMatch(/without an error|0 agent sessions/);
  });

  it('counts each way the sessions ended', async () => {
    const body = await park(await cappedRun(['completed', 'failed', 'cancelled', 'running']));
    expect(body).toContain(
      '4 agent sessions worked this run: 1 completed, 1 failed, 1 stopped, 1 still open.',
    );
  });

  it('stores the code as the reason and words it for the bell (criterion 192)', async () => {
    const issueId = await cappedRun(['failed']);
    await park(issueId);
    const [moved] = await harness.db.execute<{ reason: string | null }>(sql`
      SELECT reason FROM kernel_transitions
       WHERE entity = 'issue' AND entity_id = ${issueId} AND to_status = 'needs_info'
    `);
    expect(moved?.reason).not.toMatch(/_/);
    const { bodyForStatus } = await import('../../src/notifications/notify-transitions.js');
    expect(bodyForStatus('needs_info', 'autonomous_rescue_cap_reached')).toBe(moved?.reason);
  });
});

// ISS-1228 r20 (rig): a run held for a box that will free was rescued three times and parked for a person,
// under a comment saying nothing worked on it, while the run itself read Held.
describe('a hold that clears by itself is work, not a stuck issue (criterion 198)', () => {
  async function heldRun(hold: string): Promise<string> {
    const issueId = await cappedRun(['failed']);
    await harness.db.execute(
      sql`UPDATE issues SET updated_at = now() - interval '10 minutes' WHERE id = ${issueId}`,
    );
    const [run] = await harness.db.execute<{ id: string }>(
      sql`SELECT id FROM pipeline_runs WHERE issue_id = ${issueId}`,
    );
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status, failure_reason,
                        payload, queued_at)
      VALUES (${randomUUID()}, ${projectId}, ${issueId}, ${run?.id}, ${ownerId}, 'drive', 'held',
              'all_devices_exhausted', ${hold}::jsonb, now() - interval '10 minutes')
    `);
    return issueId;
  }

  async function sweep(issueId: string) {
    const { runReconcilerOnce } = await import('../../src/pipeline/reconciler.js');
    await runReconcilerOnce();
    const [issue] = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM issues WHERE id = ${issueId}`,
    );
    const comments = await harness.db.execute<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${issueId}`,
    );
    return { status: issue?.status, comments: comments.length };
  }

  it('leaves an issue whose job waits on a hold that resumes itself at Open, with no park comment', async () => {
    for (const hold of [
      '{}',
      '{"__hold":{"reason":"all_devices_exhausted","heldAt":"2026-10-20T00:00:00Z","autoRelease":true}}',
    ]) {
      await truncateAll(harness.db);
      ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
      const org = await seedOrg(harness.db, ownerId);
      projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
      expect(await sweep(await heldRun(hold))).toEqual({ status: 'open', comments: 0 });
    }
  });

  it('still rescues, and at the limit parks, an issue whose hold has spent its one release', async () => {
    const issueId = await heldRun(
      '{"__hold":{"reason":"all_devices_exhausted","heldAt":"2026-10-20T00:00:00Z","autoRelease":false}}',
    );
    expect(await sweep(issueId)).toEqual({ status: 'needs_info', comments: 1 });
  });
});
