/**
 * ISS-5 / ISS-6 — a claimed job is prepared under its project's policy, against a real Postgres:
 * the state its issue is at picks the model and the deny list the runner starts the pane without,
 * and a project the policy cannot place is refused by name with the job left queued.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let mods: {
  prepareJobForMaster: typeof import('../../src/devices/claim.js').prepareJobForMaster;
  startJobForMaster: typeof import('../../src/devices/claim.js').startJobForMaster;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();
  mods = await import('../../src/devices/claim.js');
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

/** Both acts of one claim, in the order a runner performs them. */
async function take(jobId: string, deviceId: string) {
  const sessionId = randomUUID();
  const prepared = await mods.prepareJobForMaster({ jobId, deviceId, sessionId });
  if (!prepared.ok) return prepared;
  const started = await mods.startJobForMaster({ jobId, deviceId, sessionId });
  if (!started.ok) return started;
  return prepared;
}

/** One project with `policy` (absent: the default, `null`: none), one box, one queued job. */
async function seed(opts: { policy?: Record<string, unknown> | null; status?: string } = {}) {
  const owner = await createTestUser(harness.db);
  const project = await createTestProject(
    harness.db,
    owner.id,
    opts.policy === undefined ? {} : { policy: opts.policy },
  );
  const device = await createTestDevice(harness.db, owner.id);
  const issue = randomUUID();
  const run = randomUUID();
  const job = randomUUID();
  await harness.db.execute(sql`
    UPDATE devices SET agent_version = '0.11.0', last_seen_at = now() WHERE id = ${device.id}
  `);
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, type, name, status, last_seen_at)
    VALUES (${randomUUID()}, ${project.id}, ${device.id}, 'claude-code', 'pool-runner', 'online', now())
  `);
  await harness.db.execute(sql`
    UPDATE runners SET repo_path = '/tmp/pool-test' WHERE project_id = ${project.id}
  `);
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
    VALUES (${issue}, ${project.id}, 9002, 'the work', ${opts.status ?? 'open'}, 'high', ${owner.id})
  `);
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
    VALUES (${run}, ${project.id}, ${issue}, 'issue', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, created_by, queued_at,
                      payload)
    VALUES (${job}, ${project.id}, ${issue}, ${run}, 'code', 'queued', ${owner.id},
            now() - interval '30 minutes', '{"promptString":"do the step"}'::jsonb)
  `);
  return { project, device, job };
}

const PLANTED = {
  $schema: 'https://forge.sidcorp.co/schemas/policy-v1.json',
  version: 1,
  qa: 'independent',
  intake: { mode: 'auto' },
  permissions: {
    driver: { deny: ['CronCreate'] },
    builder: { deny: ['Bash(git push:*)', 'mcp__forge__forge_projects_update'] },
  },
  states: {
    open: { model: 'sonnet', permissions: 'driver' },
    needs_info: { model: 'opus', permissions: 'driver' },
  },
};

describe('the policy state decides the model and the deny list', () => {
  it('carries the deny list of the state its issue is at into the prepared job', async () => {
    const { device, job } = await seed({
      policy: {
        ...PLANTED,
        states: { ...PLANTED.states, in_progress: { model: 'haiku', permissions: 'builder' } },
      },
      status: 'in_progress',
    });

    const result = await take(job, device.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.deniedTools).toEqual([
      'Bash(git push:*)',
      'mcp__forge__forge_projects_update',
    ]);
    expect(result.prepared.model).toBe('haiku');
    expect(result.prepared.policy).toMatchObject({
      revision: 1,
      status: 'in_progress',
      from: 'issue',
      profile: 'builder',
      qa: 'independent',
    });
    expect(result.prepared.systemPrompt).toContain('`Bash(git push:*)`');
  });

  it('gives a new project the driver deny list, from the policy written for it', async () => {
    const { device, job } = await seed();

    const result = await take(job, device.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.deniedTools).toEqual([
      'CronCreate',
      'CronDelete',
      'CronList',
      'Workflow',
      'RemoteTrigger',
      'ScheduleWakeup',
    ]);
    expect(result.prepared.model).toBe('opus');
  });

  it('refuses a job of a project with no policy by name, and leaves it queued and unheld', async () => {
    const { device, job, project } = await seed({ policy: null });

    const result = await take(job, device.id);

    expect(result).toMatchObject({
      ok: false,
      reason: 'policy_refused',
      code: 'POLICY_UNDECLARED',
    });
    if (result.ok) return;
    expect('detail' in result && result.detail).toContain(project.id);
    const [row] = (await harness.db.execute(sql`
      SELECT status, device_id FROM jobs WHERE id = ${job}
    `)) as unknown as Array<{ status: string; device_id: string | null }>;
    expect(row).toEqual({ status: 'queued', device_id: null });
  });

  it('refuses a job at a state the policy leaves out, never lending it another state', async () => {
    const { device, job } = await seed({ policy: PLANTED, status: 'in_progress' });

    const result = await take(job, device.id);

    expect(result).toMatchObject({
      ok: false,
      reason: 'policy_refused',
      code: 'POLICY_STATE_UNDECLARED',
    });
  });
});
