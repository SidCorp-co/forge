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
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { replaceCriteria } from '../../src/issues/criteria/service.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestDevice,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import {
  type DeclaredProbes,
  seedProduction,
  seedProductionDeployTrigger,
} from '../helpers/release-world.js';

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await truncateAll();
});

const LABEL = 'release-box';
const NOTE = { section: 'Skip', userFacing: '-' };

interface World {
  projectId: string;
  userId: string;
  token: string;
}

async function seed(
  over: { bindingConfig?: Record<string, unknown>; probes?: DeclaredProbes } = {},
): Promise<World> {
  const user = await createTestUser({ verified: true });
  const project = await createTestProject(user.id);
  await addProjectMember(project.id, user.id, 'admin');
  for (const slug of ['build-commands', 'test-commands', 'release-procedure']) {
    await db.execute(sql`
      INSERT INTO knowledge_entries (id, project_id, slug, title, body, kind)
      VALUES (${randomUUID()}, ${project.id}, ${slug}, ${slug}, 'declared', 'rule')
    `);
  }
  await seedProduction({
    projectId: project.id,
    ownerId: user.id,
    config: over.bindingConfig ?? { releaseRunnerLabel: LABEL },
    connectionConfig: { rollback: { mode: 'coolify-image' } },
    deploysFrom: 'production',
    probes: over.probes ?? 'source',
  });
  return { projectId: project.id, userId: user.id, token: await userToken(user.id) };
}

async function seedRunner(w: World): Promise<void> {
  const device = await createTestDevice(w.userId, { status: 'online' });
  await db.execute(sql`
    INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
    VALUES (${randomUUID()}, ${w.projectId}, 'claude-code', ${device}, 'box', 'online', now(),
            ${JSON.stringify([LABEL])}::jsonb)
  `);
}

async function seedAutoRelease(w: World): Promise<void> {
  await seedProductionDeployTrigger(w.projectId, w.userId);
}

let seq = 0;
async function seedIssue(w: World, note: unknown = NOTE): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await db.execute(sql`
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
  const rows = await db.execute<{ prefix: string | null; seq: number }>(sql`
    SELECT p.issue_prefix AS prefix, i.iss_seq AS seq
      FROM issues i JOIN projects p ON p.id = i.project_id
     WHERE i.id = ${issueId}
  `);
  return `${rows[0]?.prefix ?? 'ISS'}-${Number(rows[0]?.seq)}`;
}

/** One `in_progress` issue at `step`, which nothing claims; at `test` it is one move short of
 *  the gate (ISS-54). */
async function seedNearGate(w: World, step: 'build' | 'test'): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at)
    VALUES (${id}, ${w.projectId}, ${seq}, ${`near ${seq}`}, 'in_progress', ${w.userId}, now())
  `);
  await db.execute(
    sql`INSERT INTO issue_work_state (issue_id, step, step_started_at) VALUES (${id}, ${step}, now())`,
  );
  return id;
}

/**
 * Numbered criteria and no verdict for any of them, which is what holds it. The gate reads the
 * criterion rows (ISS-55), planted beside the text because the issue already stands where its
 * criteria are locked and no writer would change them.
 */
async function owesCriteria(issueId: string, text: string): Promise<void> {
  await seedIssueStatus(issueId, 'in_progress');
  await replaceCriteria(
    issueId,
    text.split('\n').map((line, i) => ({ n: i + 1, statement: line.replace(/^\d+\. /, '') })),
  );
  await seedIssueStatus(issueId, 'awaiting_release');
}

/** A runner's status as an operator's drain leaves it, written under the kernel flag. */
async function seedRunnerStatus(deviceId: string, status: string): Promise<void> {
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`UPDATE runners SET status = ${status} WHERE device_id = ${deviceId}`),
  );
}

async function readiness(w: World) {
  const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/release-readiness`);
  return {
    status: res.status,
    body: res.body as unknown as {
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
  const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/runners`);
  expect(res.status).toBe(200);
  return res.body as unknown as Array<{ deviceName: string | null }>;
}

/** Binds a device to the project through the real route — the write that
 *  snapshots `runners.name` from `devices.name` at that moment and never
 *  again (ISS-1127, criterion 17). */
async function bindRunner(w: World, deviceId: string): Promise<void> {
  const res = await api(w.token, 'POST', `/api/projects/${w.projectId}/runners`, { deviceId });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function createBatch(w: World, issueIds: string[]) {
  const res = await api(w.token, 'POST', `/api/projects/${w.projectId}/release-batches`, {
    issueIds,
  });
  return {
    status: res.status,
    body: res.body as {
      code?: string;
      error?: { refusals?: Array<{ code: string; detail: string }> };
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

    const listed = refused.body.error?.refusals ?? [];
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('RELEASE_REFUSED');
    expect(listed.map((r) => r.code)).toEqual(answer.body.blockers.map((b) => b.code));
    expect(listed[0]?.code).toBe('RELEASE_RECORD_MISSING');
    expect(listed[0]?.detail).toBe(
      answer.body.blockers.find((b) => b.code === 'RELEASE_RECORD_MISSING')?.message,
    );
  });

  it('reports an empty roster rather than promising a release of nothing', async () => {
    const w = await seed();
    await seedRunner(w);

    const codes = (await readiness(w)).body.blockers.map((b) => b.code);

    expect(codes).toContain('RELEASE_ROSTER_EMPTY');
  });

  it('names a production whose probes identify only an artifact, where the create used to throw a 500', async () => {
    const w = await seed({ probes: 'artifact-only' });
    await seedRunner(w);
    const issue = await seedIssue(w);

    const answer = await readiness(w);
    const refused = await createBatch(w, [issue]);

    expect(answer.body.blockers.map((b) => b.code)).toContain('RELEASE_PROBES_UNREADABLE');
    expect(refused.status).toBe(422);
    expect(refused.body.error?.refusals?.map((r) => r.code)).toContain('RELEASE_PROBES_UNREADABLE');
  });

  it('reports an unmet runner-label preference as a warning that stops nothing', async () => {
    const w = await seed();
    const device = await createTestDevice(w.userId, { status: 'online' });
    await db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
      VALUES (${randomUUID()}, ${w.projectId}, 'claude-code', ${device}, 'unlabelled',
              'online', now(), '[]'::jsonb)
    `);
    const issue = await seedIssue(w);

    const answer = await readiness(w);
    const created = await createBatch(w, [issue]);

    expect(answer.body.warnings.map((x) => x.code)).toContain('RELEASE_RUNNER_PREFERENCE_UNMET');
    expect(answer.body.blockers).toEqual([]);
    expect(created.status).toBe(201);
  });

  it('offers both acts with the screen each is taken on, and names no blocker either raises', async () => {
    const w = await seed();
    const device = await createTestDevice(w.userId, { status: 'online' });
    await db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
      VALUES (${randomUUID()}, ${w.projectId}, 'claude-code', ${device}, 'unlabelled',
              'online', now(), '[]'::jsonb)
    `);
    await seedIssue(w);

    const answer = await readiness(w);
    expect(answer.body.warnings.map((x) => x.code)).toContain('RELEASE_RUNNER_PREFERENCE_UNMET');
    const warned = answer.body.warnings.find((x) => x.code === 'RELEASE_RUNNER_PREFERENCE_UNMET');

    expect(warned?.message).toContain("Label the box you want this project's releases to run on");
    expect(warned?.message).toContain('Settings \u2192 Runners');
    expect(warned?.message).toContain(
      'clear `releaseRunnerLabel` from the production deploy binding under Settings \u2192 Integrations ' +
        'AND from the connection behind it under Integrations in the workspace rail',
    );
    expect(warned?.message).toContain(
      "Clearing it from the binding alone falls back to the connection's label rather than to none.",
    );
    expect(warned?.message).not.toContain('does stop a release');
  });

  it('takes the withdrawal and adds no blocker to the project it was taken on', async () => {
    const w = await seed();
    const device = await createTestDevice(w.userId, { status: 'online' });
    await db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
      VALUES (${randomUUID()}, ${w.projectId}, 'claude-code', ${device}, 'unlabelled',
              'online', now(), '[]'::jsonb)
    `);
    await seedIssue(w);
    const before = (await readiness(w)).body.blockers.map((b) => b.code);

    await db.execute(sql`
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
  it('names the box an operator retired, and the switch that returns it', async () => {
    const w = await seed();
    const device = await createTestDevice(w.userId, {
      status: 'online',
      name: 'dev1',
    });
    await db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
      VALUES (${randomUUID()}, ${w.projectId}, 'claude-code', ${device}, 'dev1', 'draining',
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

  it('names the box under the name the Runners tab shows, not the runner row name', async () => {
    const w = await seed();
    const device = await createTestDevice(w.userId, {
      status: 'online',
      name: 'workshop-box',
    });
    await db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
      VALUES (${randomUUID()}, ${w.projectId}, 'claude-code', ${device}, 'binding-42',
              'draining', now(), ${JSON.stringify([LABEL])}::jsonb)
    `);
    await seedIssue(w);

    const tab = await projectRunners(w);
    const held = (await readiness(w)).body.blockers.find((b) => b.code === 'NO_RUNNER_ONLINE');

    expect(tab.map((r) => r.deviceName)).toEqual(['workshop-box']);
    expect(held?.message).toContain('workshop-box');
    expect(held?.message).not.toContain('binding-42');
  });

  it('keeps naming the box by its current name after the device is renamed post-bind', async () => {
    const w = await seed();
    const device = await createTestDevice(w.userId, {
      status: 'online',
      name: 'sid-xeon-1',
    });
    await bindRunner(w, device);
    await seedRunnerStatus(device, 'draining');
    await db.execute(sql`UPDATE devices SET name = 'sid-xeon-1 (CLI runner)' WHERE id = ${device}`);
    await seedIssue(w);

    const tab = await projectRunners(w);
    const held = (await readiness(w)).body.blockers.find((b) => b.code === 'NO_RUNNER_ONLINE');

    expect(tab.map((r) => r.deviceName)).toEqual(['sid-xeon-1 (CLI runner)']);
    expect(held?.message).toContain('sid-xeon-1 (CLI runner)');
  });

  it('counts the issues standing one move short of the gate, and not one still building', async () => {
    const w = await seed();
    await seedRunner(w);
    await seedNearGate(w, 'test');
    await seedNearGate(w, 'test');
    await seedNearGate(w, 'build');

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
    expect(held?.message).toContain(`\`${await shownAs(issue)}\` owes criteria 1, 2`);
    expect(held?.message).not.toContain(issue);
    expect(held?.details?.held).toEqual([
      { issueId: issue, displayId: await shownAs(issue), criteria: [1, 2] },
    ]);
  });

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
