/**
 * ISS-1228 round 20 (rig) — an issue page said "No runner is online for this project" while both of
 * its runners were online, one on a build too old and one held back by an account limit, beside a
 * capacity notice naming both. Its runner wait now reads the notice's own fleet.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function onlineRunner(
  projectId: string,
  ownerId: string,
  agentVersion: string,
): Promise<string> {
  const device = await createTestDevice(harness.db, ownerId);
  await harness.db.execute(sql`
    UPDATE devices SET status = 'online', last_seen_at = now(), agent_version = ${agentVersion}
     WHERE id = ${device.id}
  `);
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at)
    VALUES (${id}, ${projectId}, 'claude-code', ${device.id}, ${`runner-${agentVersion}`}, 'online', now())
  `);
  return id;
}

describe("an issue's runner wait names what keeps its online runners from the step (criterion 200)", () => {
  it('names a build too old and an account limit, never "no runner online"', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    await onlineRunner(project.id, owner.id, '0.10.0');
    const limited = await onlineRunner(project.id, owner.id, '0.99.0');
    await harness.db.execute(
      sql`UPDATE runners SET rate_limited_until = now() + interval '3 hours' WHERE id = ${limited}`,
    );
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (${issueId}, ${project.id}, 8, 'Tidy the export footer', 'in_progress', 'medium', ${owner.id})
    `);
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
      VALUES (${runId}, ${project.id}, ${issueId}, 'issue', 'running')
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, payload, created_by)
      VALUES (${randomUUID()}, ${project.id}, ${issueId}, ${runId}, 'drive', 'queued', '{}'::jsonb, ${owner.id})
    `);

    const { hydratePipelineHealthForIssues } = await import('../../src/issues/pipeline-health.js');
    const health = (await hydratePipelineHealthForIssues(project.id, [issueId])).get(issueId);
    expect(health?.waitingOn?.reason).toBe('runner_capacity');
    expect(health?.waitingOn?.details).toMatchObject({
      online: 2,
      bars: ['too_old', 'limited'],
      summary:
        'Both of its runners are online, but one is running a build too old to take work, and one is held back by an account limit. Steps keep waiting and resume by themselves once one can take them.',
    });
  });
});
