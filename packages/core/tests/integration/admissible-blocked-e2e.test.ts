/**
 * ISS-1100 — a blocked issue is not admissible, judged at the door a box reads.
 *
 * Every assertion here goes through `GET /api/devices/me/issues/admissible` with
 * a device credential, because that route's `items` array is the whole of what
 * `work_digest` hashes and what `admissible.is_empty()` asks. An assertion
 * against `readAdmissibleIssues` would prove the filter and say nothing about
 * whether a master stops being woken, which is the proposition this issue is
 * about.
 *
 * Real Postgres on purpose: the clause is a correlated `NOT EXISTS` over
 * `issue_dependencies` with a `valid_until` comparison against `now()`, and a
 * mocked `db.execute` can answer none of that.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import { BLOCKER_SETTLED_STATUSES } from '../../src/issues/dependency-effects.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

/**
 * `open` is deliberately NOT in `poolBacklog.statuses`: it is an
 * `AUTONOMOUS_DRIVER_STATUS`, so `BACKLOG_ADMISSIBLE_STATUSES` excludes it and
 * naming it here makes the WHOLE `pipelineConfig` unparseable — `admissionOf`
 * then returns null and every row vanishes for a reason that has nothing to do
 * with blockers. Written that way first while building this file, it turned
 * every "is held out" assertion below green on an empty set. `open` reaches the
 * admissible set through the autonomous entry status instead.
 */
const BACKLOG_CONFIG = {
  pipelineConfig: {
    enabled: true,
    poolBacklog: { statuses: ['confirmed', 'approved', 'reopen'], limit: 20 },
  },
};

let harness: TestDatabase;
let userId: string;
let projectId: string;
let deviceToken: string;
let app: { request: (path: string, init?: RequestInit) => Promise<Response> };

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  ({ app } = (await import('../../src/index.js')) as unknown as { app: typeof app });
});

afterAll(async () => {
  await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  userId = (await createTestUser(harness.db)).id;
  projectId = (await createTestProject(harness.db, userId)).id;
  await harness.db.execute(sql`
    UPDATE projects SET agent_config = ${JSON.stringify(BACKLOG_CONFIG)}::jsonb
    WHERE id = ${projectId}
  `);

  const { pairDevice } = await import('../helpers/pair-device.js');
  const issued = await pairDevice({ ownerId: userId, name: 'nudge-box', platform: 'linux' });
  deviceToken = issued.plaintext;
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, name, type, status)
    VALUES (${randomUUID()}, ${projectId}, ${issued.device.id}, 'nudge-runner', 'claude-code', 'online')
  `);
});

async function issue(seq: number, status = 'open'): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${userId},
            CASE WHEN ${status} = 'closed' THEN now() END)
  `);
  return id;
}

async function edge(
  from: string,
  to: string,
  opts: { kind?: string; validUntil?: 'past' | 'future'; holdsUntil?: 'settled' | 'shipped' } = {},
): Promise<void> {
  const validUntil =
    opts.validUntil === 'past'
      ? sql`now() - interval '1 day'`
      : opts.validUntil === 'future'
        ? sql`now() + interval '30 days'`
        : sql`NULL`;
  await harness.db.execute(sql`
    INSERT INTO issue_dependencies
      (id, project_id, from_issue_id, to_issue_id, kind, valid_until, holds_until)
    VALUES (${randomUUID()}, ${projectId}, ${from}, ${to}, ${opts.kind ?? 'blocks'}, ${validUntil},
            ${opts.holdsUntil ?? 'settled'})
  `);
}

/** What the box actually reads: the route's own `items`, by key. */
async function admissible(): Promise<{ keys: string[]; count: number }> {
  const res = await app.request('/api/devices/me/issues/admissible', {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Array<{ issueKey: string }>; count: number };
  return { keys: body.items.map((i) => i.issueKey), count: body.count };
}

async function setStatus(id: string, status: string): Promise<void> {
  await harness.db.execute(sql`UPDATE issues SET status = ${status} WHERE id = ${id}`);
}

/**
 * An unblocked row planted in the same fixture as every "is held out" case, so
 * that assertion cannot pass on a set that is empty for some other reason.
 * It is not decoration: with `open` wrongly listed under `poolBacklog.statuses`
 * the config stopped parsing, the route answered `[]` for everything, and each
 * negative below was green while proving nothing.
 */
async function control(): Promise<void> {
  await issue(99);
}

describe('ISS-1100 the blocks clause (real Postgres, through the route)', () => {
  it('omits an issue held behind a blocker below developed', async () => {
    await control();
    const blocker = await issue(1, 'needs_info');
    const held = await issue(2);
    await edge(blocker, held);

    await expect(admissible()).resolves.toEqual({ keys: ['ISS-99'], count: 1 });
  });

  it('returns that same issue once its blocker reaches developed', async () => {
    const blocker = await issue(1, 'needs_info');
    const held = await issue(2);
    await edge(blocker, held);
    expect((await admissible()).keys).toEqual([]);

    await setStatus(blocker, 'developed');

    await expect(admissible()).resolves.toEqual({ keys: ['ISS-2'], count: 1 });
  });

  it.each(BLOCKER_SETTLED_STATUSES)(
    'releases the dependent when the blocker is %s',
    async (status) => {
      const blocker = await issue(1, status);
      const held = await issue(2);
      await edge(blocker, held);

      expect((await admissible()).keys).toContain('ISS-2');
    },
  );

  it.each([
    'draft',
    'open',
    'confirmed',
    'approved',
    'in_progress',
    'waiting',
    'needs_info',
    'on_hold',
    'reopen',
  ])(
    'still holds the dependent when the blocker is %s, even carrying a merge stamp',
    async (status) => {
      await control();
      const blocker = await issue(1, status);
      const held = await issue(2);
      await edge(blocker, held);
      await harness.db.execute(sql`UPDATE issues SET merged_at = now() WHERE id = ${blocker}`);

      const keys = (await admissible()).keys;
      expect(keys).toContain('ISS-99');
      expect(keys).not.toContain('ISS-2');
    },
  );

  it('admits an issue whose only blocks edge has already expired', async () => {
    const blocker = await issue(1, 'needs_info');
    const held = await issue(2);
    await edge(blocker, held, { validUntil: 'past' });

    expect((await admissible()).keys).toContain('ISS-2');
  });

  it('keeps holding an issue whose blocks edge expires in the future', async () => {
    await control();
    const blocker = await issue(1, 'needs_info');
    const held = await issue(2);
    await edge(blocker, held, { validUntil: 'future' });

    const keys = (await admissible()).keys;
    expect(keys).toContain('ISS-99');
    expect(keys).not.toContain('ISS-2');
  });

  it.each(['relates', 'decomposes', 'duplicates', 'parent'])(
    'admits an issue whose only edge is %s',
    async (kind) => {
      const other = await issue(1, 'needs_info');
      const held = await issue(2);
      await edge(other, held, { kind });

      expect((await admissible()).keys).toContain('ISS-2');
    },
  );

  it('admits an issue that blocks a parked one rather than the other way round', async () => {
    const blocked = await issue(1, 'needs_info');
    const blocker = await issue(2);
    await edge(blocker, blocked);

    expect((await admissible()).keys).toContain('ISS-2');
  });

  it('keeps holding an issue where one of two blockers is still unsettled', async () => {
    await control();
    const settled = await issue(1, 'closed');
    const unsettled = await issue(2, 'waiting');
    const held = await issue(3);
    await edge(settled, held);
    await edge(unsettled, held);

    const keys = (await admissible()).keys;
    expect(keys).toContain('ISS-99');
    expect(keys).not.toContain('ISS-3');
  });
});

describe('ISS-1100 the measurement, and the shape the box reads', () => {
  /**
   * codemap as it actually stood at 2026-09-19, read off the tracker: five rows
   * at a takeable status, each behind one live `blocks` edge, and 258 nudges in
   * the previous 24 hours. This is the measurement of criterion 24 made
   * deterministic — the count on the box falls because this set is empty.
   */
  it('admits nothing for codemaps five real candidates and their real blockers', async () => {
    const pairs: Array<[number, number, string]> = [
      [34, 64, 'needs_info'],
      [60, 65, 'waiting'],
      [60, 66, 'waiting'],
      [67, 68, 'waiting'],
      [69, 70, 'waiting'],
    ];
    const blockers = new Map<number, string>();
    for (const [blockerSeq, , status] of pairs) {
      if (!blockers.has(blockerSeq)) blockers.set(blockerSeq, await issue(blockerSeq, status));
    }
    for (const [blockerSeq, heldSeq] of pairs) {
      const held = await issue(heldSeq);
      await edge(blockers.get(blockerSeq) as string, held);
    }

    const got = await admissible();
    expect(got.count).toBe(0);
    expect(got.keys).toEqual([]);

    // The same fixture with one blocker answered: the set is no longer empty, so
    // the zero above is this filter's doing and not the fixture's.
    await setStatus(blockers.get(34) as string, 'developed');
    expect((await admissible()).keys).toEqual(['ISS-64']);
  });

  it('answers 200 with an empty items array rather than an error', async () => {
    const blocker = await issue(1, 'waiting');
    const held = await issue(2);
    await edge(blocker, held);

    const res = await app.request('/api/devices/me/issues/admissible', {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], count: 0 });
  });
});

describe('ISS-1225 an edge that holds until shipped (real Postgres, through the route)', () => {
  it.each(['developed', 'testing', 'awaiting_release'])(
    'keeps the dependent out while the blocker is %s',
    async (status) => {
      await control();
      const blocker = await issue(1, status);
      const held = await issue(2);
      await edge(blocker, held, { holdsUntil: 'shipped' });

      const keys = (await admissible()).keys;
      expect(keys).toContain('ISS-99');
      expect(keys).not.toContain('ISS-2');
    },
  );

  it('releases the dependent once the blocker is closed', async () => {
    const blocker = await issue(1, 'awaiting_release');
    const held = await issue(2);
    await edge(blocker, held, { holdsUntil: 'shipped' });
    expect((await admissible()).keys).not.toContain('ISS-2');

    // closing is refused without the merge mark: `closed` means the work shipped
    await harness.db.execute(
      sql`UPDATE issues SET status = 'closed', merged_at = now() WHERE id = ${blocker}`,
    );

    expect((await admissible()).keys).toContain('ISS-2');
  });

  it('holds only the dependent of the edge that asked, beside a settled edge on the same blocker', async () => {
    await control();
    const blocker = await issue(1, 'awaiting_release');
    const waits = await issue(2);
    const goes = await issue(3);
    await edge(blocker, waits, { holdsUntil: 'shipped' });
    await edge(blocker, goes);

    const keys = (await admissible()).keys;
    expect(keys).toContain('ISS-3');
    expect(keys).not.toContain('ISS-2');
  });

  it('still holds a shipped edge while the blocker is below developed', async () => {
    await control();
    const blocker = await issue(1, 'in_progress');
    const held = await issue(2);
    await edge(blocker, held, { holdsUntil: 'shipped' });

    expect((await admissible()).keys).not.toContain('ISS-2');
  });

  it('releases the dependent when a shipped edge is retracted', async () => {
    const blocker = await issue(1, 'awaiting_release');
    const held = await issue(2);
    await edge(blocker, held, { holdsUntil: 'shipped', validUntil: 'past' });

    expect((await admissible()).keys).toContain('ISS-2');
  });

  it('releases the dependent when the blocker is dropped, which expires its edges', async () => {
    const blocker = await issue(1, 'awaiting_release');
    const held = await issue(2);
    await edge(blocker, held, { holdsUntil: 'shipped' });
    await harness.db.execute(
      sql`UPDATE issue_dependencies SET valid_until = now() WHERE from_issue_id = ${blocker}`,
    );
    await setStatus(blocker, 'dropped');

    expect((await admissible()).keys).toContain('ISS-2');
  });

  it("reports each edge's hold on the relations of the admissible row", async () => {
    const blocker = await issue(1, 'closed');
    const held = await issue(2);
    await edge(blocker, held, { holdsUntil: 'shipped' });

    const res = await app.request('/api/devices/me/issues/admissible', {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const body = (await res.json()) as {
      items: Array<{ issueKey: string; relations: Array<{ holdsUntil: string }> }>;
    };
    const row = body.items.find((i) => i.issueKey === 'ISS-2');
    expect(row?.relations.map((r) => r.holdsUntil)).toEqual(['shipped']);
  });

  it('a database refuses a shipped hold on an edge that is not a blocks edge', async () => {
    const a = await issue(1);
    const b = await issue(2);
    await expect(edge(a, b, { kind: 'relates', holdsUntil: 'shipped' })).rejects.toThrow();
  });

  it('a database refuses a hold outside settled and shipped', async () => {
    const a = await issue(1);
    const b = await issue(2);
    await expect(
      harness.db.execute(sql`
        INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind, holds_until)
        VALUES (${randomUUID()}, ${projectId}, ${a}, ${b}, 'blocks', 'whenever')
      `),
    ).rejects.toThrow();
  });
});
