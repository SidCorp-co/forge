/**
 * ISS-1127 — the evening this issue was filed, reproduced end to end.
 *
 * Releasing twenty merged issues took five attempts, and each attempt revealed
 * exactly one blocker, only after the previous one was cleared:
 * `release-readiness` answered `gaps: []`, and `POST /release-batches` then
 * refused with `NO_RUNNER_ONLINE` — a reason that had been true the whole time
 * and appeared in no list anybody had read.
 *
 * So the property under test is an equivalence, and it is asserted in both
 * directions: an empty `blockers` is a promise that the create succeeds, and a
 * non-empty one names EVERY reason rather than the first the door reached.
 * Through the real route mount and a real database, because a refusal that is
 * mocked proves the mock.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

let probe: Server;
let probeUrl = '';

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';

  const [batch, jwt, err, registry, tab, auth] = await Promise.all([
    import('../../src/release-batch/routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
    import('../../src/integrations/register-all.js'),
    import('../../src/projects/runners-routes.js'),
    import('../../src/middleware/auth.js'),
  ]);
  registry.registerAllIntegrations();
  signUserToken = jwt.signUserToken;
  app = new Hono();
  app.route('/api/projects', batch.releaseBatchRoutes);
  // The Runners tab's own route, under the middleware `projectRoutes` gives it.
  // A blocker that names a box is asserted against what this answers rather
  // than against a literal, so the two cannot drift apart unnoticed.
  const runnersTab = new Hono();
  runnersTab.use('*', auth.requireAuth(), auth.assertEmailVerified());
  runnersTab.route('/', tab.projectRunnerRoutes);
  app.route('/api/projects', runnersTab);
  app.onError(err.errorHandler);

  probe = createServer((_req, res) => res.end('commit-live'));
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  probeUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/version`;
}, 60_000);

afterAll(async () => {
  if (probe) await new Promise<void>((done) => probe.close(() => done()));
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

const LABEL = 'release-box';
const NOTE = { section: 'Skip', userFacing: '-' };

interface World {
  projectId: string;
  userId: string;
  token: string;
}

async function seed(over: { bindingConfig?: Record<string, unknown> } = {}): Promise<World> {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  // Everything `gaps` reports, declared — so a non-empty `blockers` beside an
  // empty `gaps` is the reproduction and not a half-configured fixture.
  await harness.db.execute(sql`
    UPDATE projects
       SET base_branch = 'main', live_branch = 'production',
           release_model = 'promote', release_strategy = 'merge-branch',
           repo_path = '/srv/app',
           environments = ${JSON.stringify({
             live: { url: 'https://app.example.test', commitUrl: probeUrl },
           })}::jsonb
     WHERE id = ${project.id}
  `);
  for (const slug of ['build-commands', 'test-commands', 'release-procedure']) {
    await harness.db.execute(sql`
      INSERT INTO knowledge_entries (id, project_id, slug, title, body, kind)
      VALUES (${randomUUID()}, ${project.id}, ${slug}, ${slug}, 'declared', 'rule')
    `);
  }
  const connection = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
    VALUES (${connection}, 'user', ${user.id}, 'coolify', true)
  `);
  await harness.db.execute(sql`
    INSERT INTO integration_bindings (connection_id, project_id, provider, role, stages, active, config)
    VALUES (${connection}, ${project.id}, 'coolify', 'deploy', ARRAY['live'], true, ${JSON.stringify(
      over.bindingConfig ?? {
        releaseRunnerLabel: LABEL,
        rollback: { mode: 'coolify-image' },
        verify: { probes: [{ url: probeUrl }], timeoutSeconds: 5, stableReads: 1 },
      },
    )}::jsonb)
  `);
  return { projectId: project.id, userId: user.id, token: await signUserToken(user.id) };
}

async function seedRunner(w: World): Promise<void> {
  const device = await createTestDevice(harness.db, w.userId, { status: 'online' });
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
    VALUES (${randomUUID()}, ${w.projectId}, 'claude-code', ${device.id}, 'box', 'online', now(),
            ${JSON.stringify([LABEL])}::jsonb)
  `);
}

async function seedAutoRelease(w: World): Promise<void> {
  await harness.db.execute(sql`
    UPDATE projects
       SET agent_config = ${JSON.stringify({ pipelineConfig: { autoProdDeploy: true } })}::jsonb
     WHERE id = ${w.projectId}
  `);
}

let seq = 0;
async function seedIssue(w: World, note: unknown = NOTE): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes, merged_at)
    VALUES (${id}, ${w.projectId}, ${seq}, ${`issue ${seq}`}, 'awaiting_release', ${w.userId},
            ${note === null ? null : JSON.stringify(note)}::jsonb, now())
  `);
  return id;
}

/**
 * What the issue list shows this issue as, read back from the same two tables
 * the check reads. The uuid the rows are keyed by appears on no list, no header
 * and no url a reader would recognise (ISS-1127).
 */
async function shownAs(issueId: string): Promise<string> {
  const rows = await harness.db.execute<{ prefix: string | null; seq: number }>(sql`
    SELECT p.issue_prefix AS prefix, i.iss_seq AS seq
      FROM issues i JOIN projects p ON p.id = i.project_id
     WHERE i.id = ${issueId}
  `);
  return `${rows[0]?.prefix ?? 'ISS'}-${Number(rows[0]?.seq)}`;
}

/** One issue at a status one move short of the gate, which nothing claims. */
async function seedNearGate(w: World, status: 'testing' | 'tested'): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at)
    VALUES (${id}, ${w.projectId}, ${seq}, ${`near ${seq}`}, ${status}, ${w.userId}, now())
  `);
  return id;
}

/** Numbered criteria and no verdict for any of them, which is what holds it. */
async function owesCriteria(issueId: string, text: string): Promise<void> {
  await harness.db.execute(sql`
    UPDATE issues SET acceptance_criteria = ${text} WHERE id = ${issueId}
  `);
}

async function readiness(w: World) {
  const res = await app.request(`/api/projects/${w.projectId}/release-readiness`, {
    headers: { Authorization: `Bearer ${w.token}` },
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      gaps: string[];
      blockers: Array<{
        code: string;
        message: string;
        evaluated: boolean;
        details?: Record<string, unknown>;
      }>;
      warnings: Array<{ code: string; message: string }>;
    },
  };
}

/** What the project Runners tab lists, read through the route that feeds it. */
async function projectRunners(w: World): Promise<Array<{ deviceName: string | null }>> {
  const res = await app.request(`/api/projects/${w.projectId}/runners`, {
    headers: { Authorization: `Bearer ${w.token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Array<{ deviceName: string | null }>;
}

/** Binds a device to the project through the real route — the write that
 *  snapshots `runners.name` from `devices.name` at that moment and never
 *  again (ISS-1127, criterion 17). */
async function bindRunner(w: World, deviceId: string): Promise<void> {
  const res = await app.request(`/api/projects/${w.projectId}/runners`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${w.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  expect(res.status).toBe(201);
}

async function createBatch(w: World, issueIds: string[]) {
  const res = await app.request(`/api/projects/${w.projectId}/release-batches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${w.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueIds }),
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      code?: string;
      message?: string;
      details?: { alsoBlocking?: Array<{ code: string }> };
    },
  };
}

describe('release-readiness and the create door answer the same question', () => {
  it('reports no blocker and then lets the release start, which is the equivalence', async () => {
    const w = await seed();
    await seedRunner(w);
    const issue = await seedIssue(w);

    const before = await readiness(w);
    const created = await createBatch(w, [issue]);

    expect(before.body.blockers).toEqual([]);
    expect(created.status).toBe(201);
  });

  it('names the fleet reason while gaps is empty — the evening this was filed', async () => {
    const w = await seed();
    await seedIssue(w);

    const answer = await readiness(w);

    expect(answer.body.gaps).toEqual([]);
    expect(answer.body.blockers.map((b) => b.code)).toContain('RELEASE_POOL_EMPTY');
  });

  it('names the roster reason and the fleet reason together, not one per attempt', async () => {
    const w = await seed();
    await seedIssue(w, null);

    const codes = (await readiness(w)).body.blockers.map((b) => b.code);

    expect(codes).toContain('RELEASE_RECORD_MISSING');
    expect(codes).toContain('RELEASE_POOL_EMPTY');
  });

  it('refuses the create by the code readiness printed, and carries the rest with it', async () => {
    const w = await seed();
    const issue = await seedIssue(w, null);

    const answer = await readiness(w);
    const refused = await createBatch(w, [issue]);

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('RELEASE_RECORD_MISSING');
    expect(refused.body.message).toBe(
      answer.body.blockers.find((b) => b.code === 'RELEASE_RECORD_MISSING')?.message,
    );
    expect(refused.body.details?.alsoBlocking?.map((b) => b.code)).toContain('RELEASE_POOL_EMPTY');
  });

  it('reports an empty roster rather than promising a release of nothing', async () => {
    const w = await seed();
    await seedRunner(w);

    const codes = (await readiness(w)).body.blockers.map((b) => b.code);

    expect(codes).toContain('RELEASE_ROSTER_EMPTY');
  });

  it('names a probe url that is not a url, where the create used to throw a 500', async () => {
    const w = await seed({
      bindingConfig: {
        releaseRunnerLabel: LABEL,
        rollback: { mode: 'coolify-image' },
        verify: { probes: [{ url: 'forge-beta-api.example/version' }] },
      },
    });
    await seedRunner(w);
    const issue = await seedIssue(w);

    const answer = await readiness(w);
    const refused = await createBatch(w, [issue]);

    expect(answer.body.blockers.map((b) => b.code)).toContain('RELEASE_PROBES_UNREADABLE');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('RELEASE_PROBES_UNREADABLE');
  });

  it('reports an unmet runner-label preference as a warning that stops nothing', async () => {
    const w = await seed();
    const device = await createTestDevice(harness.db, w.userId, { status: 'online' });
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
      VALUES (${randomUUID()}, ${w.projectId}, 'claude-code', ${device.id}, 'unlabelled',
              'online', now(), '[]'::jsonb)
    `);
    const issue = await seedIssue(w);

    const answer = await readiness(w);
    const created = await createBatch(w, [issue]);

    expect(answer.body.warnings.map((x) => x.code)).toContain('RELEASE_RUNNER_PREFERENCE_UNMET');
    expect(answer.body.blockers).toEqual([]);
    expect(created.status).toBe(201);
  });

  // ISS-1127 shipped this warning offering withdrawal as one of two equal ways
  // out while withdrawal raised a 409. ISS-1275 answered that by making the
  // withdrawal free, so the clause that named its cost is gone rather than
  // reworded: a cost sentence for a cost nobody pays is the same defect wearing
  // the opposite sign.
  it('offers withdrawing the label without naming any blocker it would raise', async () => {
    const w = await seed();
    const device = await createTestDevice(harness.db, w.userId, { status: 'online' });
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
      VALUES (${randomUUID()}, ${w.projectId}, 'claude-code', ${device.id}, 'unlabelled',
              'online', now(), '[]'::jsonb)
    `);
    await seedIssue(w);

    const answer = await readiness(w);
    const warned = answer.body.warnings.find((x) => x.code === 'RELEASE_RUNNER_PREFERENCE_UNMET');

    expect(warned?.message).toContain('Label the box that holds the deploy credential');
    expect(warned?.message).not.toContain('does stop a release');
  });

  it('takes the withdrawal and adds no blocker to the project it was taken on', async () => {
    const w = await seed();
    const device = await createTestDevice(harness.db, w.userId, { status: 'online' });
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
      VALUES (${randomUUID()}, ${w.projectId}, 'claude-code', ${device.id}, 'unlabelled',
              'online', now(), '[]'::jsonb)
    `);
    await seedIssue(w);
    const before = (await readiness(w)).body.blockers.map((b) => b.code);

    await harness.db.execute(sql`
      UPDATE integration_bindings
         SET config = config - 'releaseRunnerLabel'
       WHERE project_id = ${w.projectId}
    `);
    const answer = await readiness(w);

    expect(answer.body.blockers.map((b) => b.code)).toEqual(before);
    expect(answer.body.warnings.map((x) => x.code)).not.toContain(
      'RELEASE_RUNNER_PREFERENCE_UNMET',
    );
  });
});

describe('a reason names the state it was read from and the act that clears it', () => {
  // The failure ISS-1127 was reopened on. Both forge-dev boxes were green and
  // Idle on the Runners tab at 13s and 21s, and the release surface told the
  // operator to bring one up or wait for one to reconnect.
  it('names the box an operator retired, and the switch that returns it', async () => {
    const w = await seed();
    const device = await createTestDevice(harness.db, w.userId, {
      status: 'online',
      name: 'dev1',
    });
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
      VALUES (${randomUUID()}, ${w.projectId}, 'claude-code', ${device.id}, 'dev1', 'draining',
              now(), ${JSON.stringify([LABEL])}::jsonb)
    `);
    await seedIssue(w);

    const answer = await readiness(w);
    const held = answer.body.blockers.find((b) => b.code === 'NO_RUNNER_ONLINE');

    expect(held).toBeDefined();
    expect(held?.message).toContain('dev1');
    expect(held?.message).toContain('draining');
    expect(held?.message).toContain('Takes jobs from the pool');
    expect(held?.message).not.toContain('Bring one up');
  });

  // The forge-dev fleet carried `devices.name` = 'dev1 CLI runner' against
  // `runners.name` = 'dev1', so the blocker named a box under a string no
  // screen shows. The two names are deliberately disjoint here: with one a
  // substring of the other, a message carrying the wrong one still passes.
  it('names the box under the name the Runners tab shows, not the runner row name', async () => {
    const w = await seed();
    const device = await createTestDevice(harness.db, w.userId, {
      status: 'online',
      name: 'workshop-box',
    });
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
      VALUES (${randomUUID()}, ${w.projectId}, 'claude-code', ${device.id}, 'binding-42',
              'draining', now(), ${JSON.stringify([LABEL])}::jsonb)
    `);
    await seedIssue(w);

    const tab = await projectRunners(w);
    const held = (await readiness(w)).body.blockers.find((b) => b.code === 'NO_RUNNER_ONLINE');

    expect(tab.map((r) => r.deviceName)).toEqual(['workshop-box']);
    expect(held?.message).toContain('workshop-box');
    expect(held?.message).not.toContain('binding-42');
  });

  // The actual mechanism, not just the mismatch as it stands today:
  // `POST /:id/runners` snapshots `runners.name` from `devices.name` at bind
  // time and never refreshes it (no `name` in its `onConflictDoUpdate` set,
  // and no other write keeps the two in step for a box that stays bound and
  // is later renamed). A test asserting only that two already-different
  // strings compare correctly would pass on a fresh row and never have
  // caught this — so this one binds first, at one name, and renames the
  // device only afterward.
  it('keeps naming the box by its current name after the device is renamed post-bind', async () => {
    const w = await seed();
    const device = await createTestDevice(harness.db, w.userId, {
      status: 'online',
      name: 'sid-xeon-1',
    });
    await bindRunner(w, device.id);
    await harness.db.execute(
      sql`UPDATE runners SET status = 'draining' WHERE device_id = ${device.id}`,
    );
    await harness.db.execute(
      sql`UPDATE devices SET name = 'sid-xeon-1 (CLI runner)' WHERE id = ${device.id}`,
    );
    await seedIssue(w);

    const tab = await projectRunners(w);
    const held = (await readiness(w)).body.blockers.find((b) => b.code === 'NO_RUNNER_ONLINE');

    expect(tab.map((r) => r.deviceName)).toEqual(['sid-xeon-1 (CLI runner)']);
    expect(held?.message).toContain('sid-xeon-1 (CLI runner)');
  });

  it('counts the issues standing one move short of the gate', async () => {
    const w = await seed();
    await seedRunner(w);
    await seedNearGate(w, 'testing');
    await seedNearGate(w, 'tested');

    const empty = (await readiness(w)).body.blockers.find((b) => b.code === 'RELEASE_ROSTER_EMPTY');

    expect(empty?.message).toContain('2 issues');
    expect(empty?.message).toContain('`awaiting_release`');
    expect(empty?.message).not.toContain('merged and marked');
  });
});

describe('the reason the unattended sweep will not carry an issue', () => {
  it('blocks where every waiting issue owes a judging run', async () => {
    const w = await seed();
    await seedAutoRelease(w);
    await seedRunner(w);
    const issue = await seedIssue(w);
    await owesCriteria(issue, '1. it answers\n2. it answers twice');

    const answer = await readiness(w);
    const held = answer.body.blockers.find((b) => b.code === 'RELEASE_CRITERIA_UNEARNED');

    expect(held).toBeDefined();
    expect(held?.message).toContain(`\`${await shownAs(issue)}\` owes criterion 1, 2`);
    expect(held?.message).not.toContain(issue);
    expect(held?.details?.held).toEqual([
      { issueId: issue, displayId: await shownAs(issue), criteria: [1, 2] },
    ]);
  });

  // A partial exclusion is not a stopped release: `sweepProject` returns early
  // only where NOTHING is left eligible, and otherwise cuts the subset.
  it('warns rather than blocks where a release still starts without them', async () => {
    const w = await seed();
    await seedAutoRelease(w);
    await seedRunner(w);
    const held = await seedIssue(w);
    await owesCriteria(held, '1. it answers');
    await seedIssue(w);

    const answer = await readiness(w);

    expect(answer.body.blockers.map((b) => b.code)).not.toContain('RELEASE_CRITERIA_UNEARNED');
    const warned = answer.body.warnings.find((x) => x.code === 'RELEASE_CRITERIA_HELD_BACK');
    expect(warned?.message).toContain(`\`${await shownAs(held)}\` owes criterion 1`);
    expect(warned?.message).not.toContain(held);
  });

  it('says nothing about criteria on a project a person releases by hand', async () => {
    const w = await seed();
    await seedRunner(w);
    const issue = await seedIssue(w);
    await owesCriteria(issue, '1. it answers');

    const codes = (await readiness(w)).body.blockers.map((b) => b.code);

    expect(codes).not.toContain('RELEASE_CRITERIA_UNEARNED');
  });

  it('never refuses a create that named its own list by that code', async () => {
    const w = await seed();
    await seedAutoRelease(w);
    await seedRunner(w);
    const issue = await seedIssue(w);
    await owesCriteria(issue, '1. it answers');

    const answer = await readiness(w);
    const created = await createBatch(w, [issue]);

    expect(answer.body.blockers.map((b) => b.code)).toContain('RELEASE_CRITERIA_UNEARNED');
    expect(created.status).toBe(201);
  });
});
