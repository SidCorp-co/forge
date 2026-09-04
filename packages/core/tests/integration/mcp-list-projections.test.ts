/**
 * The two list projections that exist to keep a transcript-sized column out of
 * an MCP result.
 *
 * Both were asserted by spying on `db.select()`'s argument, which measures the
 * shape of a call and not the shape of a row: a projection that names the right
 * keys and a query that returns the wrong ones are indistinguishable to a spy.
 * These read the actual rows back out of Postgres, so an added column fails
 * here whatever the call looked like.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('MCP list projections', () => {
  let harness: TestDatabase;
  let listSchedulesForMcp: typeof import('../../src/schedules/service.js').listSchedulesForMcp;
  let listAgentSessionsForMcp: typeof import('../../src/agent-sessions/service.js').listAgentSessionsForMcp;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';
    ({ listSchedulesForMcp } = await import('../../src/schedules/service.js'));
    ({ listAgentSessionsForMcp } = await import('../../src/agent-sessions/service.js'));
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seed() {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    return { user, project };
  }

  it('a schedule row reaches an agent without its 20k prompt', async () => {
    const { project } = await seed();
    await harness.db.execute(sql`
      INSERT INTO schedules (id, project_id, name, cron, enabled, prompt)
      VALUES (${randomUUID()}, ${project.id}, 'nightly', '0 0 * * *', true,
        ${'x'.repeat(20000)})
    `);

    const [row] = await listSchedulesForMcp(project.id);

    expect(row).toBeDefined();
    expect(row?.name).toBe('nightly');
    expect(Object.keys(row ?? {})).not.toContain('prompt');
    expect(Object.keys(row ?? {})).not.toContain('script');
  });

  it('a session row reaches an agent without its transcript, but with its length', async () => {
    const { user, project } = await seed();
    const messages = JSON.stringify([{ role: 'user' }, { role: 'assistant' }, { role: 'user' }]);
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (${issueId}, ${project.id}, 1, 'Issue 1', 'in_progress', 'medium', ${user.id})
    `);
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${project.id}, ${issueId}, 'issue', 'running', now())
    `);
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, user_id, pipeline_run_id, title, status, messages)
      VALUES (${randomUUID()}, ${project.id}, ${user.id}, ${runId}, 'chat', 'completed', ${messages}::jsonb)
    `);

    const [row] = await listAgentSessionsForMcp({ projectId: project.id, limit: 10 });

    expect(row).toBeDefined();
    expect(Object.keys(row ?? {})).not.toContain('messages');
    expect(row?.messageCount).toBe(3);
    // cm:guard `diff` and the three `pipeline*` jsonb columns are unbounded too, and the REST list carries them while this one must not — asserting only `messages` would let the next widening through the one gap it actually costs an agent its turn to hit.
    for (const heavy of [
      'diff',
      'usage',
      'pipelineControl',
      'pipelineTelemetry',
      'pipelineHealth',
    ]) {
      expect(Object.keys(row ?? {})).not.toContain(heavy);
    }
  });
});
