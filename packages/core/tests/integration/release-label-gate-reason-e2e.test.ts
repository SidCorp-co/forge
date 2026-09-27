/**
 * ISS-1080 criteria 1-5 and 27 — the release label is a gate a reader can see;
 * and ISS-1128, which made it a preference, so what the gate now reports is
 * whether ANY box that could claim may take the job rather than whether this
 * one carries the label.
 *
 * `RUNNER_MAY_TAKE_JOB` hid a `release_batch` job from every box on the fleet
 * and `buildGateReasonCase` had no arm for it, so the two surfaces that exist
 * to explain a waiting job both said the opposite of what had happened: the
 * gate map reported the job as fully dispatchable, and the wedge it therefore
 * raised told the owner the picker was offering the job to a selector that
 * kept declining it. Nobody had been offered anything.
 *
 * Integration and not unit, and the reason is the whole of `queued-gates.ts`:
 * the answer is one raw CASE whose arms are ordered, and what is under test is
 * which arm a row matches. `queued-gates.test.ts` mocks `db.execute` and reads
 * the SQL back as a string — it can prove the text contains an arm and can
 * prove nothing at all about which row that arm selects, so a green there is
 * not weak evidence for these criteria, it is none.
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
  assertDispatchable: typeof import('../../src/jobs/queued-gates.js').assertDispatchable;
  gateReasonsForQueuedJobs: typeof import('../../src/jobs/queued-gates.js').gateReasonsForQueuedJobs;
  alarmStalledQueuedJobs: typeof import('../../src/pipeline/inv7-alarms.js').alarmStalledQueuedJobs;
  computeAlerts: typeof import('../../src/admin/alert-queries.js').computeAlerts;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();
  mods = {
    assertDispatchable: (await import('../../src/jobs/queued-gates.js')).assertDispatchable,
    gateReasonsForQueuedJobs: (await import('../../src/jobs/queued-gates.js'))
      .gateReasonsForQueuedJobs,
    alarmStalledQueuedJobs: (await import('../../src/pipeline/inv7-alarms.js'))
      .alarmStalledQueuedJobs,
    computeAlerts: (await import('../../src/admin/alert-queries.js')).computeAlerts,
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
  jobId: string;
}

/**
 * One project, one box, one queued job under a live run.
 *
 * `labels` is what the box carries and `declaredLabel` is what the project's
 * live deploy binding names; every case below moves one of the two, or takes
 * the box off the fleet with `runnerOnline`.
 */
async function seed(opts: {
  type: string;
  labels: string[];
  declaredLabel?: string | null;
  runnerOnline?: boolean;
  queuedMinutesAgo?: number;
}): Promise<World> {
  const owner = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, owner.id);
  const device = await createTestDevice(harness.db, owner.id);
  const runner = randomUUID();
  const run = randomUUID();
  const job = randomUUID();
  const connection = randomUUID();
  const online = opts.runnerOnline ?? true;
  const ageMinutes = opts.queuedMinutesAgo ?? 0;

  await harness.db.execute(sql`
    UPDATE devices SET agent_version = '0.11.0', last_seen_at = now() WHERE id = ${device.id}
  `);
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, type, name, status, last_seen_at, labels)
    VALUES (
      ${runner}, ${project.id}, ${device.id}, 'claude-code', 'box',
      ${online ? 'online' : 'offline'}, now(), ${JSON.stringify(opts.labels)}::jsonb
    )
  `);
  if (opts.declaredLabel !== null && opts.declaredLabel !== undefined) {
    await harness.db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, active, config)
      VALUES (${connection}, 'user', ${owner.id}, 'coolify', true, '{}'::jsonb)
    `);
    await harness.db.execute(sql`
      INSERT INTO integration_bindings (connection_id, project_id, provider, role, stages, active, config)
      VALUES (
        ${connection}, ${project.id}, 'coolify', 'deploy', ARRAY['live'], true,
        ${JSON.stringify({ releaseRunnerLabel: opts.declaredLabel })}::jsonb
      )
    `);
  }
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${run}, ${project.id}, 'system', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, type, status, created_by, queued_at, created_at)
    VALUES (
      ${job}, ${project.id}, ${run}, ${opts.type}, 'queued', ${owner.id},
      now() - (${ageMinutes}::int * interval '1 minute'),
      now() - (${ageMinutes}::int * interval '1 minute')
    )
  `);
  return { projectId: project.id, jobId: job };
}

const reasonFor = async (w: World) =>
  (await mods.gateReasonsForQueuedJobs(w.projectId)).get(w.jobId);

/**
 * A second box on the same project.
 *
 * ISS-1128 — a release job is hidden from an unlabelled box only while a box
 * that CAN take the release carries the label, so every case meaning "the
 * label hides this job" has to put one on the fleet.
 */
async function addBox(
  w: World,
  labels: string[],
  opts: { agentVersion?: string } = {},
): Promise<void> {
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
      ${`box-${device.id.slice(0, 8)}`}, 'online', now(), ${JSON.stringify(labels)}::jsonb
    )
  `);
}

const wedgeCount = async (): Promise<number> => {
  const rows = (await harness.db.execute(sql`
    SELECT count(*)::int AS n FROM notifications WHERE type = 'pipeline_wedge'
  `)) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
};

/** A second live deploy binding naming a different label, which nobody but a person resolves. */
async function addDisagreeingBinding(w: World, label: string): Promise<void> {
  const owner = (await harness.db.execute(sql`
    SELECT created_by AS id FROM projects WHERE id = ${w.projectId}
  `)) as unknown as Array<{ id: string }>;
  const connection = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active, config)
    VALUES (${connection}, 'user', ${owner[0]?.id}, 'coolify', true, '{}'::jsonb)
  `);
  await harness.db.execute(sql`
    INSERT INTO integration_bindings (connection_id, project_id, provider, role, stages, active, config)
    VALUES (
      ${connection}, ${w.projectId}, 'coolify', 'deploy', ARRAY['live'], true,
      ${JSON.stringify({ releaseRunnerLabel: label })}::jsonb
    )
  `);
}

describe('the release label is a gate reason', () => {
  // ISS-1128 — this arm answers a question about the JOB, not about one box:
  // can anything that could claim take it. A box carrying the wrong label beside
  // one carrying the right label is ordinary routing, and the job is not waiting
  // on anybody.
  it('says nothing when a live box carries the wrong one and another carries it', async () => {
    const w = await seed({ type: 'release_batch', labels: ['staging-box'], declaredLabel: LABEL });
    await addBox(w, [LABEL]);

    expect(await reasonFor(w)).toBeUndefined();
  });

  // ISS-1275 — a project that declares no label is not waiting on anybody: the
  // job reaches the pool, so there is no reason to report.
  it('says nothing when the project resolves no label at all', async () => {
    const w = await seed({ type: 'release_batch', labels: [LABEL], declaredLabel: null });

    expect(await reasonFor(w)).toBeUndefined();
  });

  it('says nothing when no box that could claim carries the label', async () => {
    const w = await seed({ type: 'release_batch', labels: [], declaredLabel: LABEL });

    expect(await reasonFor(w)).toBeUndefined();
  });

  it('says nothing when the box carrying the label is below the claim floor', async () => {
    const w = await seed({ type: 'release_batch', labels: [], declaredLabel: LABEL });
    await addBox(w, [LABEL], { agentVersion: '0.10.0' });

    expect(await reasonFor(w)).toBeUndefined();
  });

  it('still says runner_too_old when every fresh box is below the claim floor', async () => {
    const w = await seed({ type: 'release_batch', labels: [LABEL], declaredLabel: LABEL });
    await harness.db.execute(sql`
      UPDATE devices SET agent_version = '0.10.0'
      WHERE id IN (SELECT device_id FROM runners WHERE project_id = ${w.projectId})
    `);

    expect(await reasonFor(w)).toBe('runner_too_old');
  });

  it('names the label when two live bindings disagree about it', async () => {
    const w = await seed({ type: 'release_batch', labels: [LABEL], declaredLabel: LABEL });
    await addDisagreeingBinding(w, 'a-second-box');

    expect(await reasonFor(w)).toBe('release_label_missing');
  });

  it('says nothing about a release job the box can actually take', async () => {
    const w = await seed({ type: 'release_batch', labels: [LABEL], declaredLabel: LABEL });

    expect(await reasonFor(w)).toBeUndefined();
  });

  it('answers assertDispatchable with the same reason', async () => {
    const w = await seed({ type: 'release_batch', labels: [], declaredLabel: LABEL });
    await addDisagreeingBinding(w, 'a-second-box');

    expect(await mods.assertDispatchable(w.jobId)).toEqual({
      ok: false,
      reason: 'release_label_missing',
    });
  });

  it('still says runner_stale when there is no live box at all', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [],
      declaredLabel: LABEL,
      runnerOnline: false,
    });

    expect(await reasonFor(w)).toBe('runner_stale');
  });

  it('never names the label for a job of another type', async () => {
    const w = await seed({ type: 'code', labels: [], declaredLabel: LABEL });

    expect(await reasonFor(w)).toBeUndefined();
  });
});

describe('the surfaces that report a waiting job', () => {
  it('raises no wedge for a job the label hides', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [],
      declaredLabel: LABEL,
      queuedMinutesAgo: 120,
    });
    await addDisagreeingBinding(w, 'a-second-box');

    await mods.alarmStalledQueuedJobs(new Date());

    expect(await reasonFor(w)).toBe('release_label_missing');
    expect(await wedgeCount()).toBe(0);
  });

  it('still raises one for a job nothing explains', async () => {
    await seed({
      type: 'release_batch',
      labels: [LABEL],
      declaredLabel: LABEL,
      queuedMinutesAgo: 120,
    });

    await mods.alarmStalledQueuedJobs(new Date());

    expect(await wedgeCount()).toBe(1);
  });

  it('counts a release job no box may take as starvation', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [],
      declaredLabel: LABEL,
      queuedMinutesAgo: 120,
    });
    await addDisagreeingBinding(w, 'a-second-box');

    const alerts = await mods.computeAlerts({ now: new Date() });
    const a3 = alerts.find((a) => a.id === 'A3');

    expect(a3?.entities.map((e) => e.ref)).toContain(w.projectId);
  });

  it('stops counting one an unlabelled box may now take', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [],
      declaredLabel: LABEL,
      queuedMinutesAgo: 120,
    });

    const alerts = await mods.computeAlerts({ now: new Date() });
    const a3 = alerts.find((a) => a.id === 'A3');

    expect(a3?.entities.map((e) => e.ref) ?? []).not.toContain(w.projectId);
  });

  it('does not count a release job its own box can take', async () => {
    const w = await seed({
      type: 'release_batch',
      labels: [LABEL],
      declaredLabel: LABEL,
      queuedMinutesAgo: 120,
    });

    const alerts = await mods.computeAlerts({ now: new Date() });
    const a3 = alerts.find((a) => a.id === 'A3');

    expect(a3?.entities.map((e) => e.ref)).not.toContain(w.projectId);
  });
});
