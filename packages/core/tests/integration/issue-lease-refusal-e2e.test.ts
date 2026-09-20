/**
 * ISS-1109 — a second box asking for an issue that is already taken.
 *
 * The refusal IS the deliverable. A box told only that the open failed retries
 * against the same holder until the lease lapses; one told which device holds
 * the issue and since when has an act to take, and a different act depending on
 * whether the holder is itself or a stranger. Nothing refused the second taker
 * before this, because no index can constrain an element of a jsonb array.
 *
 * The other half — that a free issue stays free, that a lapsed lease is taken,
 * and that the readers agree — is `issue-lease-e2e.test.ts`.
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
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  const runSession = await import('../../src/devices/run-session.js');
  mods = {
    openRunSession: runSession.openRunSession,
    closeRunSession: runSession.closeRunSession,
    isIssueLeaseHeld: runSession.isIssueLeaseHeld,
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

/** How many run sessions exist right now, whoever opened them. */
async function sessionCount(): Promise<number> {
  const rows = (await harness.db.execute(
    sql`SELECT count(*)::int AS n FROM agent_sessions`,
  )) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

async function runCount(): Promise<number> {
  const rows = (await harness.db.execute(
    sql`SELECT count(*)::int AS n FROM pipeline_runs`,
  )) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
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

describe('a second box over an issue that is already held', () => {
  it('is refused rather than joining the run silently', async () => {
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
        issueKeys: ['ISS-880'],
        name: 'run-b',
      }),
    );

    expect(
      refusal,
      'a second box that is told nothing opens its own run over the same issue, which is two agents writing one branch',
    ).not.toBeNull();
  });

  it('names the issue key it refused over', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();
    await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-881'],
      name: 'run-a',
    });

    const refusal = await refusalOf(
      mods.openRunSession({
        deviceId: boxB.id,
        projectId: project.id,
        issueKeys: ['ISS-880', 'ISS-881'],
        name: 'run-b',
      }),
    );

    expect(refusal?.message).toContain('ISS-881');
  });

  it('names the box holding it', async () => {
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
        issueKeys: ['ISS-880'],
        name: 'run-b',
      }),
    );

    expect(
      refusal?.message,
      'a refusal with no holder in it sends an operator to the database to find out which box to stop',
    ).toContain(boxA.id);
  });

  it('names when the lease was taken', async () => {
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
        issueKeys: ['ISS-880'],
        name: 'run-b',
      }),
    );

    expect(refusal?.message).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('reads differently when the holder is the asking box itself', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();
    await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });

    const sameBox = await refusalOf(
      mods.openRunSession({
        deviceId: boxA.id,
        projectId: project.id,
        issueKeys: ['ISS-880'],
        name: 'run-a-again',
      }),
    );
    const otherBox = await refusalOf(
      mods.openRunSession({
        deviceId: boxB.id,
        projectId: project.id,
        issueKeys: ['ISS-880'],
        name: 'run-b',
      }),
    );

    expect(
      sameBox?.message,
      'a box refused by its own earlier run has a different act to take from one refused by a stranger, and one sentence for both hides which it is',
    ).not.toEqual(otherBox?.message);
  });

  it('leaves no run session behind for the group it refused', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();
    await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });
    const sessionsBefore = await sessionCount();

    await refusalOf(
      mods.openRunSession({
        deviceId: boxB.id,
        projectId: project.id,
        issueKeys: ['ISS-880'],
        name: 'run-b',
      }),
    );

    expect(await sessionCount()).toBe(sessionsBefore);
  });

  it('leaves no pipeline run behind for the group it refused', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();
    await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });
    const runsBefore = await runCount();

    await refusalOf(
      mods.openRunSession({
        deviceId: boxB.id,
        projectId: project.id,
        issueKeys: ['ISS-880'],
        name: 'run-b',
      }),
    );

    expect(await runCount()).toBe(runsBefore);
  });

  it('leaves the holder still holding it', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();
    await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });

    await refusalOf(
      mods.openRunSession({
        deviceId: boxB.id,
        projectId: project.id,
        issueKeys: ['ISS-880'],
        name: 'run-b',
      }),
    );

    expect(
      await mods.isIssueLeaseHeld({ deviceId: boxA.id, issueKey: 'ISS-880' }),
      'a refusal that takes the holder down with it is worse than the double-hold it replaced',
    ).toBe(true);
  });
});

describe('two boxes racing for one issue', () => {
  it('ends with one run session and one refusal', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();

    const outcomes = await Promise.allSettled([
      mods.openRunSession({
        deviceId: boxA.id,
        projectId: project.id,
        issueKeys: ['ISS-880'],
        name: 'run-a',
      }),
      mods.openRunSession({
        deviceId: boxB.id,
        projectId: project.id,
        issueKeys: ['ISS-880'],
        name: 'run-b',
      }),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
  });

  it('names the holder in the one that lost', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();

    const outcomes = await Promise.allSettled([
      mods.openRunSession({
        deviceId: boxA.id,
        projectId: project.id,
        issueKeys: ['ISS-880'],
        name: 'run-a',
      }),
      mods.openRunSession({
        deviceId: boxB.id,
        projectId: project.id,
        issueKeys: ['ISS-880'],
        name: 'run-b',
      }),
    ]);

    const lost = outcomes.find((o) => o.status === 'rejected');
    expect((lost as PromiseRejectedResult | undefined)?.reason?.message).toContain('ISS-880');
  });

  it('settles overlapping groups named in opposite orders without waiting on each other', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();

    const settled = await Promise.race([
      Promise.allSettled([
        mods.openRunSession({
          deviceId: boxA.id,
          projectId: project.id,
          issueKeys: ['ISS-880', 'ISS-881'],
          name: 'run-a',
        }),
        mods.openRunSession({
          deviceId: boxB.id,
          projectId: project.id,
          issueKeys: ['ISS-881', 'ISS-880'],
          name: 'run-b',
        }),
      ]),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 15_000)),
    ]);

    expect(
      settled,
      'two boxes taking the same pair in opposite orders lock each other out of Postgres itself, and a deadlock is a box that never reports at all',
    ).not.toBe('timed out');
  });

  it('gives an overlapping pair in opposite orders exactly one winner', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();

    const outcomes = (await Promise.allSettled([
      mods.openRunSession({
        deviceId: boxA.id,
        projectId: project.id,
        issueKeys: ['ISS-880', 'ISS-881'],
        name: 'run-a',
      }),
      mods.openRunSession({
        deviceId: boxB.id,
        projectId: project.id,
        issueKeys: ['ISS-881', 'ISS-880'],
        name: 'run-b',
      }),
    ])) as PromiseSettledResult<unknown>[];

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  });

  it('gives an overlapping pair in opposite orders one named refusal', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();

    const outcomes = (await Promise.allSettled([
      mods.openRunSession({
        deviceId: boxA.id,
        projectId: project.id,
        issueKeys: ['ISS-880', 'ISS-881'],
        name: 'run-a',
      }),
      mods.openRunSession({
        deviceId: boxB.id,
        projectId: project.id,
        issueKeys: ['ISS-881', 'ISS-880'],
        name: 'run-b',
      }),
    ])) as PromiseSettledResult<unknown>[];

    const lost = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult | undefined;
    expect(lost?.reason?.message).toMatch(/ISS-88[01]/);
  });
});

/**
 * ISS-1109 — a group whose middle key carries a dead holder is still refused
 * by name.
 *
 * This is the reap and the take running under contention: two boxes over the
 * same pair, one key of which has a lease left behind by a session that died.
 * It exercises the per-key path `takeIssueLeases` acquires through, and pins
 * that what a loser gets is `IssueLeaseHeldError` and not a driver error.
 *
 * What it does NOT prove, measured rather than assumed: it does not reproduce
 * the lock inversion that per-key acquisition exists to remove. That schedule
 * needs a session to go terminal BETWEEN two openers' reaps, which two racing
 * `openRunSession` calls do not produce — run four times against the
 * whole-group reap this replaced, it passed every time. The inversion is
 * closed structurally, by never reaching a higher key before a lower one, and
 * that property is not what this case measures.
 */
describe('a stale lease in the middle of a contended group', () => {
  it('still ends in a named refusal rather than a database error', async () => {
    const { project, boxA, boxB } = await twoBoxesOnOneProject();
    // ISS-881 — the HIGHER key — carries a lease whose holder then dies, which
    // is the row whose reap is conditional and so orders differently per box.
    const stale = await mods.openRunSession({
      deviceId: boxA.id,
      projectId: project.id,
      issueKeys: ['ISS-881'],
      name: 'run-stale',
    });
    await harness.db.execute(sql`
      UPDATE agent_sessions SET status = 'failed' WHERE id = ${stale.sessionId}
    `);

    const outcomes = await Promise.allSettled([
      mods.openRunSession({
        deviceId: boxA.id,
        projectId: project.id,
        issueKeys: ['ISS-880', 'ISS-881'],
        name: 'run-a',
      }),
      mods.openRunSession({
        deviceId: boxB.id,
        projectId: project.id,
        issueKeys: ['ISS-881', 'ISS-880'],
        name: 'run-b',
      }),
    ]);

    const rejected = outcomes.filter((o) => o.status === 'rejected');
    for (const r of rejected) {
      expect(
        (r as PromiseRejectedResult).reason?.constructor?.name,
        'a box aborted for deadlock is told a SQLSTATE, not which box holds the issue',
      ).toBe('IssueLeaseHeldError');
    }
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});
