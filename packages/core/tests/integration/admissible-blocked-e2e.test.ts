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

describe('ISS-1100 admissible means takeable (real Postgres, through the route)', () => {
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
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${userId})
    `);
    return id;
  }

  async function edge(
    from: string,
    to: string,
    opts: { kind?: string; validUntil?: 'past' | 'future' } = {},
  ): Promise<void> {
    const validUntil =
      opts.validUntil === 'past'
        ? sql`now() - interval '1 day'`
        : opts.validUntil === 'future'
          ? sql`now() + interval '30 days'`
          : sql`NULL`;
    await harness.db.execute(sql`
      INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind, valid_until)
      VALUES (${randomUUID()}, ${projectId}, ${from}, ${to}, ${opts.kind ?? 'blocks'}, ${validUntil})
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

  it('omits an issue held behind a blocker below developed', async () => {
    await control();
    const blocker = await issue(1, 'needs_info');
    const held = await issue(2);
    await edge(blocker, held);

    await expect(admissible()).resolves.toEqual({ keys: ['ISS-99'], count: 1 });
  });

  // cm:guard the other direction of the same clause, and the pair is the point: a filter that hid everything would pass the case above on its own.
  it('returns that same issue once its blocker reaches developed', async () => {
    const blocker = await issue(1, 'needs_info');
    const held = await issue(2);
    await edge(blocker, held);
    expect((await admissible()).keys).toEqual([]);

    await setStatus(blocker, 'developed');

    await expect(admissible()).resolves.toEqual({ keys: ['ISS-2'], count: 1 });
  });

  // cm:guard each settled status judged on its own. A clause written against one of them, or against
  // a range, goes green on `closed` alone while `developed` and `testing` still hide their dependents.
  it.each(['developed', 'testing', 'awaiting_release', 'closed'])(
    'releases the dependent when the blocker is %s',
    async (status) => {
      const blocker = await issue(1, status);
      const held = await issue(2);
      await edge(blocker, held);

      expect((await admissible()).keys).toContain('ISS-2');
    },
  );

  // cm:guard the statuses that must KEEP holding, one at a time. `merged_at` is deliberately stamped
  // on the blocker in each case: a merged-but-parked blocker still gates the master (`forge advance`
  // reads the status), so a clause that reached for the stamp instead would pass every case above and
  // fail exactly here.
  it.each(['draft', 'open', 'confirmed', 'approved', 'in_progress', 'waiting', 'needs_info', 'on_hold', 'reopen'])(
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

  // cm:guard retraction has to work through this filter or the documented way out of a wrong edge
  // (`forge_issues.update` with `validUntil` in the past, and the expiry `drop-cascade.ts` writes)
  // hides its dependent from every master for good.
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

  // cm:guard `blocks` is the only kind any dispatch decision may read. Widen the clause past it and
  // every grouping label in the project becomes a blocker.
  it.each(['relates', 'decomposes', 'duplicates', 'parent'])(
    'admits an issue whose only edge is %s',
    async (kind) => {
      const other = await issue(1, 'needs_info');
      const held = await issue(2);
      await edge(other, held, { kind });

      expect((await admissible()).keys).toContain('ISS-2');
    },
  );

  // cm:guard direction. The edge is `from BLOCKS to`, so an issue that BLOCKS a parked issue is not
  // itself blocked; an inverted clause passes every case above and silently empties the set.
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

  // cm:guard the empty case has to reach the box as an EMPTY ARRAY and not as a 404, a null or an
  // error: `placement_for` reads `admissible.is_empty()`, so anything else either starts a master for
  // a project with nothing takeable or makes the whole sweep go quiet on that project.
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
