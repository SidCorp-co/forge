/**
 * ISS-1042 criteria 8 and 9 — a release job reaches the box that holds the
 * production credential, and no other.
 *
 * The release pool existed on paper only. `createReleaseBatch` resolved the
 * label once, to ask whether anyone in that pool was alive, and then enqueued a
 * plain job: `readPool`'s SQL had no label predicate and `devices/claim.ts`
 * contained no occurrence of the word `label`. Whichever master polled first
 * took the production deploy.
 *
 * Integration and not unit, for both halves. `readPool` is one raw statement
 * and what is under test is which rows it returns. The label itself is read out
 * of `integration_bindings` overlaid on `integration_connections`, in the same
 * order `resolveReleaseChannel` takes them — a mock of that read cannot
 * disagree with the release path, which is the only disagreement that matters.
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

const LABEL = 'prod-credential-box';

let harness: TestDatabase;
let mods: {
  readPool: typeof import('../../src/devices/pool.js').readPool;
  prepareJobForMaster: typeof import('../../src/devices/claim.js').prepareJobForMaster;
  resolveReleasePlan: typeof import('../../src/release-batch/channel.js').resolveReleasePlan;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  mods = {
    readPool: (await import('../../src/devices/pool.js')).readPool,
    prepareJobForMaster: (await import('../../src/devices/claim.js')).prepareJobForMaster,
    resolveReleasePlan: (await import('../../src/release-batch/channel.js')).resolveReleasePlan,
  };
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

interface World {
  projectId: string;
  deviceId: string;
  jobId: string;
}

/**
 * One project, one device with a runner, one queued job under a live run.
 *
 * `labels` is what the runner carries, `bindingConfig` is what the project
 * declares, and `type` is the job — every case below moves exactly one of them.
 */
async function seed(opts: {
  type: string;
  labels: string[];
  bindingConfig?: Record<string, unknown> | null;
  connectionConfig?: Record<string, unknown>;
}): Promise<World> {
  const owner = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, owner.id);
  const device = await createTestDevice(harness.db, owner.id);
  const runner = randomUUID();
  const run = randomUUID();
  const job = randomUUID();
  const connection = randomUUID();

  await harness.db.execute(sql`
    UPDATE devices SET agent_version = '0.11.0', last_seen_at = now() WHERE id = ${device.id}
  `);
  await harness.db.execute(sql`
    UPDATE projects SET repo_path = '/tmp/release-label-test' WHERE id = ${project.id}
  `);
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, type, name, status, last_seen_at, labels)
    VALUES (
      ${runner}, ${project.id}, ${device.id}, 'claude-code', 'box', 'online', now(),
      ${JSON.stringify(opts.labels)}::jsonb
    )
  `);
  if (opts.bindingConfig !== null) {
    await harness.db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, active, config)
      VALUES (
        ${connection}, 'user', ${owner.id}, 'coolify', true,
        ${JSON.stringify(opts.connectionConfig ?? {})}::jsonb
      )
    `);
    await harness.db.execute(sql`
      INSERT INTO integration_bindings (connection_id, project_id, provider, role, stages, active, config)
      VALUES (
        ${connection}, ${project.id}, 'coolify', 'deploy', ARRAY['live'], true,
        ${JSON.stringify(opts.bindingConfig ?? {})}::jsonb
      )
    `);
  }
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${run}, ${project.id}, 'system', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, type, status, created_by, queued_at)
    VALUES (${job}, ${project.id}, ${run}, ${opts.type}, 'queued', ${owner.id}, now())
  `);
  return { projectId: project.id, deviceId: device.id, jobId: job };
}

const poolIds = async (w: World) =>
  (await mods.readPool({ deviceId: w.deviceId, limit: 20 })).map((e) => e.jobId);

describe('a release job is offered only to the release pool', () => {
  it('offers a release job to the box that carries the project label', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [LABEL],
      bindingConfig: { releaseRunnerLabel: LABEL },
    });

    expect(await poolIds(w)).toEqual([w.jobId]);
  });

  // cm:guard this is the case the whole module exists for: before ISS-1042 the pool returned this
  // row, a master claimed it, and the production deploy ran on a box with no credential.
  it('does not offer a release job to a box that carries no label', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [],
      bindingConfig: { releaseRunnerLabel: LABEL },
    });

    expect(await poolIds(w)).toEqual([]);
  });

  it('does not offer a release job to a box carrying some other label', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: ['staging-box'],
      bindingConfig: { releaseRunnerLabel: LABEL },
    });

    expect(await poolIds(w)).toEqual([]);
  });

  // cm:guard the narrowing is for `release_batch` and nothing else. A predicate that read every job
  // type would empty the pool of the whole fleet the moment one project declared a label.
  it('goes on offering every other job type to an unlabelled box', async () => {
    const w = await seed({
      type: 'code',
      labels: [],
      bindingConfig: { releaseRunnerLabel: LABEL },
    });

    expect(await poolIds(w)).toEqual([w.jobId]);
  });

  // cm:guard a release job whose project declares NO label matches nobody, and that refusal is the
  // point: `createReleaseBatch` throws RELEASE_RUNNER_UNDECLARED before such a job can be made, so
  // the only way to hold one is to have unset the label after the cut. Widening to the fleet there
  // lands the deploy on a box with no credential, with the merge already pushed.
  it('offers a release job to nobody when the project declares no label', async () => {
    const w = await seed({ type: 'release_batch', labels: [LABEL], bindingConfig: {} });

    expect(await poolIds(w)).toEqual([]);
  });

  it('offers a release job to nobody when the project has no production binding', async () => {
    const w = await seed({ type: 'release_batch', labels: [LABEL], bindingConfig: null });

    expect(await poolIds(w)).toEqual([]);
  });
});

describe('the claim answers the same question by name', () => {
  const session = () => randomUUID();

  it('refuses a release job on an unlabelled box, naming release_label_missing', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [],
      bindingConfig: { releaseRunnerLabel: LABEL },
    });

    const res = await mods.prepareJobForMaster({
      jobId: w.jobId,
      deviceId: w.deviceId,
      sessionId: session(),
    });

    expect(res).toEqual({ ok: false, reason: 'release_label_missing' });
  });

  // cm:guard the refusal must land BEFORE the hold — a refused claim that left `held_by` set would
  // park the release behind the three-minute reaper on every poll of every box in the fleet.
  it('leaves the refused job unheld and claimable', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [],
      bindingConfig: { releaseRunnerLabel: LABEL },
    });

    await mods.prepareJobForMaster({ jobId: w.jobId, deviceId: w.deviceId, sessionId: session() });

    const rows = await harness.db.execute(sql`
      SELECT held_by, status FROM jobs WHERE id = ${w.jobId}
    `);
    expect(rows[0]).toMatchObject({ held_by: null, status: 'queued' });
  });

  // cm:guard a job that does not exist is NOT a label verdict. `prepareJobForMaster` owns
  // `not_found` and must stay the one that says it — a label check answering first would tell a
  // master its box is wrong for a job that is simply gone, which is a box an operator then goes
  // and relabels for nothing.
  it('leaves a job that does not exist to not_found, never to the label', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [],
      bindingConfig: { releaseRunnerLabel: LABEL },
    });

    const res = await mods.prepareJobForMaster({
      jobId: randomUUID(),
      deviceId: w.deviceId,
      sessionId: session(),
    });

    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });

  it('admits the release job on the labelled box', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [LABEL],
      bindingConfig: { releaseRunnerLabel: LABEL },
    });

    const res = await mods.prepareJobForMaster({
      jobId: w.jobId,
      deviceId: w.deviceId,
      sessionId: session(),
    });

    expect(res.ok).toBe(true);
  });
});

// cm:guard the two readings of "which box releases" have to be ONE reading. `resolveReleaseChannels`
// overlays the connection's config with the binding's by spreading, so a binding that sets the key
// to null HIDES the connection's value — a COALESCE in the pool's SQL would not, and the pool would
// then offer a release to a box the release itself refuses.
describe('the pool reads the label the release path reads', () => {
  it('takes the connection-level label where the binding names none', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [LABEL],
      bindingConfig: {},
      connectionConfig: { releaseRunnerLabel: LABEL },
    });

    expect((await mods.resolveReleasePlan(w.projectId)).releaseRunnerLabel).toBe(LABEL);
    expect(await poolIds(w)).toEqual([w.jobId]);
  });

  it('lets a binding null out the connection-level label, for the pool as for the release', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [LABEL],
      bindingConfig: { releaseRunnerLabel: null },
      connectionConfig: { releaseRunnerLabel: LABEL },
    });

    expect((await mods.resolveReleasePlan(w.projectId)).releaseRunnerLabel).toBeNull();
    expect(await poolIds(w)).toEqual([]);
  });
});
