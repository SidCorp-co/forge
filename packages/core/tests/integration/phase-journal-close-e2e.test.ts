/**
 * Phases an agent walked away from, against real Postgres.
 *
 * `forge_phase` is agent-declared, so nothing closes a phase if the session
 * simply ends — and that row is then indistinguishable from one whose session
 * died. Measured on KineTrak ISS-1 (2026-08-20): the issue shipped and closed
 * with its `ship` phase still open.
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

describe('phase-journal dangling close E2E', () => {
  let harness: TestDatabase;
  let ownerId: string;
  let projectId: string;
  let runId: string;

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
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    projectId = (await createTestProject(harness.db, owner.id)).id;
    runId = randomUUID();
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${issueId}, ${projectId}, 1, 'driven', 'in_progress', ${ownerId})
    `);
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running', now())
    `);
  });

  async function job(): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, type, status, payload, created_by, queued_at)
      VALUES (${id}, ${projectId}, ${runId}, 'drive', 'running', '{}'::jsonb, ${ownerId}, now())
    `);
    return id;
  }

  async function phase(jobId: string, name: string, ended: boolean): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO phase_journal (id, project_id, run_id, job_id, phase, attempt, source, outcome,
                                 started_at, ended_at)
      VALUES (${randomUUID()}, ${projectId}, ${runId}, ${jobId}, ${name}, 1, 'agent',
              ${ended ? 'ok' : null}, now(), ${ended ? sql`now()` : null})
    `);
  }

  async function rows(): Promise<Array<Record<string, unknown>>> {
    return [
      ...(await harness.db.execute(sql`
        SELECT phase, outcome, source, ended_at FROM phase_journal
        WHERE run_id = ${runId} ORDER BY phase
      `)),
    ] as Array<Record<string, unknown>>;
  }

  it('closes what the job left open and says the system did it', async () => {
    const { closeDanglingPhasesForJob } = await import('../../src/pipeline/phase-journal.js');
    const j = await job();
    await phase(j, 'merge', true);
    await phase(j, 'ship', false);

    expect(await closeDanglingPhasesForJob(j, 'ok')).toBe(1);

    const out = await rows();
    expect(out.find((r) => r.phase === 'ship')).toMatchObject({ outcome: 'ok', source: 'system' });
    expect(out.find((r) => r.phase === 'ship')?.ended_at).not.toBeNull();
  });

  // cm:guard the agent's own close must survive — re-stamping a phase the agent already ended would overwrite a real outcome with an inferred one
  it('leaves a phase the agent already closed exactly as the agent left it', async () => {
    const { closeDanglingPhasesForJob } = await import('../../src/pipeline/phase-journal.js');
    const j = await job();
    await phase(j, 'merge', true);

    await closeDanglingPhasesForJob(j, 'failed');

    expect((await rows())[0]).toMatchObject({ outcome: 'ok', source: 'agent' });
  });

  // cm:guard scoped to the JOB — a staged run holds one phase per job, so closing by run would end a sibling's phase while that job is still working in it
  it('never touches a sibling job still working in its own phase', async () => {
    const { closeDanglingPhasesForJob } = await import('../../src/pipeline/phase-journal.js');
    const finished = await job();
    const running = await job();
    await phase(finished, 'ship', false);
    await phase(running, 'code', false);

    expect(await closeDanglingPhasesForJob(finished, 'ok')).toBe(1);

    const out = await rows();
    expect(out.find((r) => r.phase === 'code')?.ended_at).toBeNull();
  });
});
