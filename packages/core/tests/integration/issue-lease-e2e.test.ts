/**
 * ISS-1109 — one issue, one holder, fleet-wide.
 *
 * Every case here is about a SECOND box: box B must not be told an issue box A
 * is running is free. These need a real Postgres because the refusal is the
 * primary key's, not a read's.
 *
 * The refusal's own text and the rows a refused open must not leave behind are
 * `issue-lease-refusal-e2e.test.ts`.
 */

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

let harness: TestDatabase;
let mods: {
  openRunSession: typeof import('../../src/devices/run-session.js').openRunSession;
  closeRunSession: typeof import('../../src/devices/run-session.js').closeRunSession;
  isIssueLeaseHeld: typeof import('../../src/devices/run-session.js').isIssueLeaseHeld;
  releaseIssueLease: typeof import('../../src/devices/run-session.js').releaseIssueLease;
  readAdmissibleIssues: typeof import('../../src/devices/admissible.js').readAdmissibleIssues;
  detectOrphanedRunAssertions: typeof import('../../src/pipeline/issue-run-invariant.js').detectOrphanedRunAssertions;
  readDeviceIssueLease: typeof import('../../src/issues/issue-lease.js').readDeviceIssueLease;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  const runSession = await import('../../src/devices/run-session.js');
  const admissible = await import('../../src/devices/admissible.js');
  const invariant = await import('../../src/pipeline/issue-run-invariant.js');
  const lease = await import('../../src/issues/issue-lease.js');
  mods = {
    openRunSession: runSession.openRunSession,
    closeRunSession: runSession.closeRunSession,
    isIssueLeaseHeld: runSession.isIssueLeaseHeld,
    releaseIssueLease: runSession.releaseIssueLease,
    readAdmissibleIssues: admissible.readAdmissibleIssues,
    detectOrphanedRunAssertions: invariant.detectOrphanedRunAssertions,
    readDeviceIssueLease: lease.readDeviceIssueLease,
  };
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

/** One project, two boxes bound to it, and a backlog both may read. */
async function twoBoxesOnOneProject(seqs: number[] = [880, 881]) {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  const boxA = await createTestDevice(harness.db, user.id);
  const boxB = await createTestDevice(harness.db, user.id);
  await harness.db.execute(sql`
    UPDATE projects
       SET agent_config = ${JSON.stringify({
         pipelineConfig: { poolBacklog: { statuses: ['draft'], limit: 20 } },
       })}::jsonb
     WHERE id = ${project.id}
  `);
  for (const [name, device] of [
    ['ra', boxA],
    ['rb', boxB],
  ] as const) {
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, name, type, status)
      VALUES (gen_random_uuid(), ${project.id}, ${device.id}, ${name}, 'claude-code', 'online')
    `);
  }
  for (const seq of seqs) {
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (gen_random_uuid(), ${project.id}, ${seq}, ${`issue ${seq}`}, 'draft', ${user.id})
    `);
  }
  return { user, project, boxA, boxB };
}

/** The error a call threw, or null where it returned. */
async function refusalOf(call: Promise<unknown>): Promise<Error | null> {
  try {
    await call;
    return null;
  } catch (err) {
    return err as Error;
  }
}

describe('the lease is one question with one answer, whoever asks', () => {
  it('answers true to a box that is not the holder', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();
    await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });

    expect(
      await mods.isIssueLeaseHeld({ deviceId: boxB.id, issueKey: 'ISS-880' }),
      'the device filter is the defect: a lease only its own holder can see refuses nobody',
    ).toBe(true);
  });

  it('answers false once the holding session is terminal', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();
    const session = await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });

    await harness.db.execute(
      sql`UPDATE agent_sessions SET status = 'failed' WHERE id = ${session.sessionId}`,
    );

    expect(await mods.isIssueLeaseHeld({ deviceId: boxB.id, issueKey: 'ISS-880' })).toBe(false);
  });

  it('lets the next box take a lease whose holder went terminal', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();
    const session = await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });
    await mods.closeRunSession({
      deviceId: boxA.id,
      sessionId: session.sessionId,
      outcome: 'died',
    });

    const refusal = await refusalOf(
      mods.openRunSession({
        deviceId: boxB.id,
        projectId: project.id,
        issueKeys: ['ISS-880'],
        name: 'run-b',
      }),
    );

    expect(
      refusal,
      'an exclusive lease that outlives its holder strands the issue where no box can take it, which is the failure this replaced one with',
    ).toBeNull();
  });

  it('leaves a free issue free', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();
    await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });

    const refusal = await refusalOf(
      mods.openRunSession({
        deviceId: boxB.id,
        projectId: project.id,
        issueKeys: ['ISS-881'],
        name: 'run-b',
      }),
    );

    expect(
      refusal,
      'a take that refuses more than the key it was asked about stops the fleet rather than the collision',
    ).toBeNull();
  });
});

describe('the readers that decide what is free', () => {
  it('keeps an issue another box holds out of the admissible set', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();
    await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });

    const keys = (
      await mods.readAdmissibleIssues({ deviceId: boxB.id, projectId: project.id })
    ).map((a) => a.issueKey);

    expect(keys).not.toContain('ISS-880');
    expect(keys).toContain('ISS-881');
  });

  it('does not call an issue another box holds an orphaned assertion', async () => {
    const { project, boxA } = await twoBoxesOnOneProject();
    await harness.db.execute(sql`
      UPDATE issues SET status = 'in_progress', updated_at = now() - interval '2 hours'
       WHERE project_id = ${project.id} AND iss_seq = 880
    `);
    await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });

    const swept = await mods.detectOrphanedRunAssertions(new Date());

    expect(
      swept.detected,
      'an issue a live run holds reported as an orphan is a false alarm every box on the fleet then argues with',
    ).toBe(0);
  });
});

describe('giving a lease back', () => {
  it('leaves a lease held by another box standing', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();
    await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });

    await mods.releaseIssueLease({ deviceId: boxB.id, issueKey: 'ISS-880' });

    expect(
      await mods.isIssueLeaseHeld({ deviceId: boxA.id, issueKey: 'ISS-880' }),
      'a box that can release another box lease can take an issue out from under a running agent',
    ).toBe(true);
  });

  it('removes the asking box own lease', async () => {
    const { project, boxA } = await twoBoxesOnOneProject();
    await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });

    await mods.releaseIssueLease({ deviceId: boxA.id, issueKey: 'ISS-880' });

    expect(await mods.isIssueLeaseHeld({ deviceId: boxA.id, issueKey: 'ISS-880' })).toBe(false);
  });

  it('frees the issue for the other box', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();
    await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });
    await mods.releaseIssueLease({ deviceId: boxA.id, issueKey: 'ISS-880' });

    const refusal = await refusalOf(
      mods.openRunSession({
        deviceId: boxB.id,
        projectId: project.id,
        issueKeys: ['ISS-880'],
        name: 'run-b',
      }),
    );

    expect(refusal).toBeNull();
  });

  it('raises nothing when the same lease is given back twice', async () => {
    const { project, boxA } = await twoBoxesOnOneProject();
    await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-880', 'ISS-881'],
      name: 'run-a',
    });

    await mods.releaseIssueLease({ deviceId: boxA.id, issueKey: 'ISS-880' });
    const second = await refusalOf(
      mods.releaseIssueLease({ deviceId: boxA.id, issueKey: 'ISS-880' }),
    );

    expect(second).toBeNull();
  });

  it('leaves the rest of the group held', async () => {
    const { project, boxA } = await twoBoxesOnOneProject();
    await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-880', 'ISS-881'],
      name: 'run-a',
    });

    await mods.releaseIssueLease({ deviceId: boxA.id, issueKey: 'ISS-880' });

    expect(await mods.isIssueLeaseHeld({ deviceId: boxA.id, issueKey: 'ISS-881' })).toBe(true);
  });
});

describe('what one box is told about one issue lease', () => {
  it('reports the holder to a box that is not holding it', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();
    const opened = await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });

    const seen = await mods.readDeviceIssueLease({ deviceId: boxB.id, issueKey: 'ISS-880' });

    expect(seen.holder?.deviceId).toBe(boxA.id);
    expect(seen.holder?.sessionId).toBe(opened.sessionId);
    expect(seen.holder?.runId).toBe(opened.runId);
    expect(
      Number.isNaN(Date.parse(String(seen.holder?.acquiredAt))),
      'an operator who cannot tell a lease taken four hours ago from one taken four seconds ago cannot tell a wedge from a race',
    ).toBe(false);
  });

  it('calls a lease another box holds held', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();
    await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });

    expect(
      (await mods.readDeviceIssueLease({ deviceId: boxB.id, issueKey: 'ISS-880' })).held,
      'the device filter is the defect: a lease only its own holder can see refuses nobody',
    ).toBe(true);
  });

  it('does not call a lease another box holds this box own', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();
    await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });

    expect(
      (await mods.readDeviceIssueLease({ deviceId: boxB.id, issueKey: 'ISS-880' }))
        .heldByThisDevice,
      'a box that reads the fleet answer as its own opens no run it should and closes no run it must',
    ).toBe(false);
  });

  it('separates the two answers for the box that is holding it', async () => {
    const { project, boxA } = await twoBoxesOnOneProject();
    await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });

    const seen = await mods.readDeviceIssueLease({ deviceId: boxA.id, issueKey: 'ISS-880' });

    expect(seen.held).toBe(true);
    expect(
      seen.heldByThisDevice,
      'a box that never sees its own lease as its own never marks the run closed, and the close loop spins for ever',
    ).toBe(true);
  });

  it('reports a free issue as held by nobody', async () => {
    const { boxA } = await twoBoxesOnOneProject();

    const seen = await mods.readDeviceIssueLease({ deviceId: boxA.id, issueKey: 'ISS-881' });

    expect(seen).toEqual({ held: false, heldByThisDevice: false, holder: null });
  });

  it('stops reporting a lease once the holding session goes terminal', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();
    const opened = await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });
    await harness.db.execute(sql`
      UPDATE agent_sessions SET status = 'failed' WHERE id = ${opened.sessionId}
    `);

    expect(
      await mods.readDeviceIssueLease({ deviceId: boxB.id, issueKey: 'ISS-880' }),
      'a lease row that outlives its session strands the issue where no box can take it',
    ).toEqual({ held: false, heldByThisDevice: false, holder: null });
  });
});
