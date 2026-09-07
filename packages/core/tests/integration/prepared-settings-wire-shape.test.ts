/**
 * What `settings` carries on the `job.assigned` frame, asserted against real
 * Postgres because `prepareClaimedJob` reads `agent_config` to build it.
 *
 * ISS-941 deleted `sessionMode: 'duplex'` from that object. Nothing in the
 * suite had ever read the object, so neither the constant's presence nor its
 * removal could go red: `settings` is built in one literal and only
 * `sessionResidencySeconds` survives there, so a deletion that took the
 * surviving key with it would have passed every gate.
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

describe('ISS-941 — the settings object on a prepared job', () => {
  let harness: TestDatabase;
  let prepareClaimedJob: typeof import('../../src/jobs/prepare-claimed-job.js').prepareClaimedJob;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';
    const prepareMod = await import('../../src/jobs/prepare-claimed-job.js');
    prepareClaimedJob = prepareMod.prepareClaimedJob;
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function prepareWith(pipelineConfig: Record<string, unknown>) {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id, {
      agentConfig: { pipelineConfig },
    });
    // cm:guard the floor at `runners/device-cap.ts` refuses a claim outright below `AGENT_NAMING_MIN_RUNNER`, so a device with no `agent_version` prepares nothing and every assertion below would read an absent key as a passing deletion.
    const device = await createTestDevice(harness.db, owner.id, { status: 'online' });
    await harness.db.execute(
      sql`UPDATE devices SET agent_version = '0.12.1', last_seen_at = now() WHERE id = ${device.id}`,
    );
    const runnerId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, capabilities, status, last_seen_at)
      VALUES (
        ${runnerId}, ${project.id}, 'claude-code', ${device.id},
        ${`runner-${runnerId.slice(0, 8)}`}, ${'{"pm": true}'}::jsonb, 'online', now()
      )
    `);
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (
        ${issueId}, ${project.id}, ${Math.floor(Math.random() * 1_000_000)},
        'Issue', 'open', 'medium', ${owner.id}
      )
    `);
    const runId = randomUUID();
    // cm:guard `pipeline_runs_issue_kind_chk` requires an issue on a run of kind `issue`.
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
      VALUES (${runId}, ${project.id}, ${issueId}, 'issue', 'running')
    `);
    const jobId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, payload, created_by)
      VALUES (
        ${jobId}, ${project.id}, ${issueId}, ${runId}, 'code', 'queued',
        ${JSON.stringify({ promptString: 'noop' })}::jsonb, ${owner.id}
      )
    `);
    return prepareClaimedJob({ jobId, deviceId: device.id });
  }

  it('does not carry sessionMode, for a project that never set one', async () => {
    const prepared = await prepareWith({ enabled: true });
    expect(prepared).not.toHaveProperty('sessionMode');
  });

  it('does not carry sessionMode even for a project whose stored config still names it', async () => {
    // cm:why the phase 6 migration strips the key, but a row written before it ran or by a client that never validated is the case where a surviving read would put it back on the wire.
    const prepared = await prepareWith({ enabled: true, sessionMode: 'print' });
    expect(prepared).not.toHaveProperty('sessionMode');
  });

  it('still carries sessionResidencySeconds when the project set a positive number', async () => {
    const prepared = await prepareWith({ sessionResidencySeconds: 600 });
    expect(prepared.sessionResidencySeconds).toBe(600);
  });

  it('omits sessionResidencySeconds when the project set nothing', async () => {
    const prepared = await prepareWith({ enabled: true });
    expect(prepared).not.toHaveProperty('sessionResidencySeconds');
  });
});
