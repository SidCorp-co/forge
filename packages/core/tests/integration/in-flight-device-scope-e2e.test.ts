/**
 * A concurrency cap restrains spawning a Claude process, and that process eats
 * the BOX. So the number a cap is compared against has to be the box's, not one
 * project binding's.
 *
 * dev1 holds 20 bindings. Counting per binding under a per-device cap would let
 * it run 20x the intended concurrency while every gate read as if it were
 * holding — the failure would look like capacity, not like a bug.
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

// cm:guard both counts are hand-written `db.execute(sql)`, so the columns they name are invisible to tsc and to any suite that mocks `db.execute`. That is exactly how `AND r.host = 'device'` outlived migration 0200 and 500'd live chat on 2026-09-04. These assertions must keep running against the migrated schema.
describe('in-flight is counted per device, not per binding', () => {
  let harness: TestDatabase;
  let mods: {
    countInFlightForDevice: typeof import('../../src/jobs/in-flight.js').countInFlightForDevice;
    countInFlightForOneRunner: typeof import('../../src/jobs/in-flight.js').countInFlightForOneRunner;
  };

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';
    const m = await import('../../src/jobs/in-flight.js');
    mods = {
      countInFlightForDevice: m.countInFlightForDevice,
      countInFlightForOneRunner: m.countInFlightForOneRunner,
    };
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  /** One box serving two projects, each binding carrying one running job. */
  async function seedOneBoxTwoProjects() {
    const owner = await createTestUser(harness.db);
    const projectA = await createTestProject(harness.db, owner.id);
    const projectB = await createTestProject(harness.db, owner.id);
    const box = await createTestDevice(harness.db, owner.id);

    const runnerA = randomUUID();
    const runnerB = randomUUID();
    for (const [id, projectId] of [
      [runnerA, projectA.id],
      [runnerB, projectB.id],
    ] as const) {
      await harness.db.execute(sql`
        INSERT INTO runners (id, project_id, device_id, name, type, status, last_seen_at)
        VALUES (${id}, ${projectId}, ${box.id}, 'box', 'claude-code', 'online', now())
      `);
    }

    const runA = randomUUID();
    const runB = randomUUID();
    for (const [runId, runnerId, projectId] of [
      [runA, runnerA, projectA.id],
      [runB, runnerB, projectB.id],
    ] as const) {
      await harness.db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, status, kind)
        VALUES (${runId}, ${projectId}, 'running', 'system')
      `);
      await harness.db.execute(sql`
        INSERT INTO jobs (id, project_id, pipeline_run_id, type, status, runner_id, device_id, created_by, queued_at, dispatched_at)
        VALUES (${randomUUID()}, ${projectId}, ${runId}, 'drive', 'running', ${runnerId}, ${box.id}, ${owner.id}, now(), now())
      `);
    }
    return { box, runnerA, runnerB, owner, projectA: projectA.id, runA };
  }

  it('sees both projects of one box, where the per-binding count sees one each', async () => {
    const s = await seedOneBoxTwoProjects();

    expect(await mods.countInFlightForDevice(s.box.id)).toBe(2);
    expect(await mods.countInFlightForOneRunner(s.runnerA)).toBe(1);
    expect(await mods.countInFlightForOneRunner(s.runnerB)).toBe(1);
  });

  it('does not count another box', async () => {
    const s = await seedOneBoxTwoProjects();
    const other = await createTestDevice(harness.db, s.owner.id);

    expect(await mods.countInFlightForDevice(other.id)).toBe(0);
  });

  // cm:guard the orphan exclusion is ISS-258 and is NOT a reporting nicety: a job under a terminal `pipeline_run` holds no slot, so counting it reports a box as full that dispatch will happily fill. The per-runner count has excluded these since the 2026-05-27 stall; this one must match or the two numbers disagree about the same box.
  it('excludes a job whose parent pipeline_run is already terminal', async () => {
    const s = await seedOneBoxTwoProjects();
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET status = 'completed' WHERE id = ${s.runA}
    `);

    expect(await mods.countInFlightForDevice(s.box.id)).toBe(1);
  });

  // cm:guard `queued` and `held` are live jobs that hold NO slot while they wait. Counting them makes a free box read as full, and dispatch rotates work away from a machine that could take it.
  it('counts neither a queued nor a held job', async () => {
    const s = await seedOneBoxTwoProjects();
    for (const status of ['queued', 'held'] as const) {
      await harness.db.execute(sql`
        INSERT INTO jobs (id, project_id, pipeline_run_id, type, status, device_id, created_by, queued_at)
        VALUES (${randomUUID()}, ${s.projectA}, ${s.runA}, 'drive', ${status}, ${s.box.id}, ${s.owner.id}, now())
      `);
    }

    expect(await mods.countInFlightForDevice(s.box.id)).toBe(2);
  });
});
