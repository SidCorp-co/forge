/**
 * ISS-1042 criteria 8 and 9 — a release job reaches the box that holds the
 * production credential, and ISS-1128 — where no eligible box holds it, the
 * job reaches the pool the project has rather than nobody.
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
  registerIntegrationsForTest,
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
  await registerIntegrationsForTest();
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

/**
 * A second box on the same project. What separates "no eligible box carries
 * the label" from "one does and this is not it" is whether the fleet holds one
 * of these, so every case that means the second says so by calling it.
 */
async function addBox(
  w: World,
  labels: string[],
  opts: { status?: 'online' | 'offline'; agentVersion?: string } = {},
): Promise<string> {
  const [row] = await harness.db.execute(sql`
    SELECT created_by FROM projects WHERE id = ${w.projectId} LIMIT 1
  `);
  const device = await createTestDevice(harness.db, String(row?.created_by), {
    status: 'online',
    ...(opts.agentVersion === undefined ? {} : { agentVersion: opts.agentVersion }),
  });
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, type, name, status, last_seen_at, labels)
    VALUES (
      ${randomUUID()}, ${w.projectId}, ${device.id}, 'claude-code',
      ${`box-${device.id.slice(0, 8)}`}, ${opts.status ?? 'online'}, now(),
      ${JSON.stringify(labels)}::jsonb
    )
  `);
  return device.id;
}

describe('a release job is offered only to the release pool', () => {
  it('offers a release job to the box that carries the project label', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [LABEL],
      bindingConfig: { releaseRunnerLabel: LABEL },
    });

    expect(await poolIds(w)).toEqual([w.jobId]);
  });

  it('does not offer a release job to a box that carries no label, while one does', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [],
      bindingConfig: { releaseRunnerLabel: LABEL },
    });
    await addBox(w, [LABEL]);

    expect(await poolIds(w)).toEqual([]);
  });

  it('does not offer a release job to a box carrying some other label, while one does', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: ['staging-box'],
      bindingConfig: { releaseRunnerLabel: LABEL },
    });
    await addBox(w, [LABEL]);

    expect(await poolIds(w)).toEqual([]);
  });

  it('offers a release job to an unlabelled box when no box on the fleet carries the label', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [],
      bindingConfig: { releaseRunnerLabel: LABEL },
    });

    expect(await poolIds(w)).toEqual([w.jobId]);
  });

  it('offers a release job to an unlabelled box when the labelled one is offline', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [],
      bindingConfig: { releaseRunnerLabel: LABEL },
    });
    await addBox(w, [LABEL], { status: 'offline' });

    expect(await poolIds(w)).toEqual([w.jobId]);
  });

  it('offers a release job to an unlabelled box when the labelled one cannot claim', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [],
      bindingConfig: { releaseRunnerLabel: LABEL },
    });
    await addBox(w, [LABEL], { agentVersion: '0.10.0' });

    expect(await poolIds(w)).toEqual([w.jobId]);
  });

  it('goes on offering every other job type to an unlabelled box', async () => {
    const w = await seed({
      type: 'code',
      labels: [],
      bindingConfig: { releaseRunnerLabel: LABEL },
    });

    expect(await poolIds(w)).toEqual([w.jobId]);
  });

  it('offers a release job to nobody when the project declares no label', async () => {
    const w = await seed({ type: 'release_batch', labels: [LABEL], bindingConfig: {} });

    expect(await poolIds(w)).toEqual([]);
  });

  it('offers a release job to nobody when the project has no live deploy binding', async () => {
    const w = await seed({ type: 'release_batch', labels: [LABEL], bindingConfig: null });

    expect(await poolIds(w)).toEqual([]);
  });
});

describe('the claim answers the same question by name', () => {
  const session = () => randomUUID();

  it('refuses a release job on an unlabelled box while one carries the label', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [],
      bindingConfig: { releaseRunnerLabel: LABEL },
    });
    await addBox(w, [LABEL]);

    const res = await mods.prepareJobForMaster({
      jobId: w.jobId,
      deviceId: w.deviceId,
      sessionId: session(),
    });

    expect(res).toEqual({ ok: false, reason: 'release_label_missing' });
  });

  it('admits a release job on an unlabelled box when no box carries the label', async () => {
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

    expect(res.ok).toBe(true);
  });

  it('admits a release job on an unlabelled box when the labelled one cannot claim', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [],
      bindingConfig: { releaseRunnerLabel: LABEL },
    });
    await addBox(w, [LABEL], { agentVersion: '0.10.0' });

    const res = await mods.prepareJobForMaster({
      jobId: w.jobId,
      deviceId: w.deviceId,
      sessionId: session(),
    });

    expect(res.ok).toBe(true);
  });

  it('leaves the refused job unheld and claimable', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [],
      bindingConfig: { releaseRunnerLabel: LABEL },
    });
    await addBox(w, [LABEL]);

    await mods.prepareJobForMaster({ jobId: w.jobId, deviceId: w.deviceId, sessionId: session() });

    const rows = await harness.db.execute(sql`
      SELECT held_by, status FROM jobs WHERE id = ${w.jobId}
    `);
    expect(rows[0]).toMatchObject({ held_by: null, status: 'queued' });
  });

  it('leaves a job that does not exist to not_found, never to the label', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [],
      bindingConfig: { releaseRunnerLabel: LABEL },
    });
    await addBox(w, [LABEL]);

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

  it('offers a release job to nobody when two live bindings name different labels', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [LABEL],
      bindingConfig: { releaseRunnerLabel: LABEL },
    });
    const otherConnection = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, active, config)
      SELECT ${otherConnection}, 'user', p.created_by, 'coolify', true, '{}'::jsonb
      FROM projects p WHERE p.id = ${w.projectId}
    `);
    await harness.db.execute(sql`
      INSERT INTO integration_bindings (connection_id, project_id, provider, role, stages, active, config)
      VALUES (
        ${otherConnection}, ${w.projectId}, 'coolify', 'deploy', ARRAY['live'], true,
        ${JSON.stringify({ releaseRunnerLabel: 'some-other-box' })}::jsonb
      )
    `);

    // The plan resolver refuses outright…
    await expect(mods.resolveReleasePlan(w.projectId)).rejects.toThrow(/RELEASE_RUNNER_AMBIGUOUS/);
    // …and the pool answers with nobody rather than picking one of the two.
    expect(await poolIds(w)).toEqual([]);
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
