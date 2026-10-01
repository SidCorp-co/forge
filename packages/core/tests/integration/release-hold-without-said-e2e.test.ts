/**
 * ISS-34 — a hold stored before `said` existed (ISS-1346) is refused by name, `HOLD_WITHOUT_SAID`,
 * and never read as a hold that has said nothing. Against real Postgres, because what is asserted
 * is what the row and its thread hold after the write.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let mod: typeof import('../../src/pipeline/release-hold.js');

const HOLD = {
  code: 'NO_RUNNER_ONLINE',
  reason: 'no runner of this project is online',
  owes: 'human' as const,
  waitingFor: 'a runner',
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  mod = await import('../../src/pipeline/release-hold.js');
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  projectId = (await createTestProject(harness.db, ownerId)).id;
});

async function heldRow(held: unknown): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, session_context)
    VALUES (${id}, ${projectId}, ${Math.floor(Math.random() * 1_000_000)}, 'held', 'awaiting_release',
            ${ownerId}, ${JSON.stringify({ [mod.RELEASE_HOLD_KEY]: held })}::jsonb)
  `);
  return id;
}

async function stateOf(id: string) {
  const [row] = (await harness.db.execute(sql`
    SELECT session_context -> 'releaseHold' AS held,
           (SELECT count(*)::int FROM comments c WHERE c.issue_id = i.id) AS comments
      FROM issues i WHERE i.id = ${id}
  `)) as unknown as Array<{ held: unknown; comments: number }>;
  return row;
}

describe('a stored hold without `said`', () => {
  const stale = { ...HOLD, at: '2026-09-01T00:00:00.000Z', status: 'awaiting_release' };

  it('is refused by name when a new reason would replace it, and the row is left as it was', async () => {
    const id = await heldRow(stale);
    const tally = await mod.writeReleaseHolds({
      issueIds: [id],
      holdFor: () => ({ ...HOLD, reason: 'every runner is rate limited' }),
      authorId: ownerId,
      now: new Date(),
    });
    expect(tally).toMatchObject({
      written: 0,
      refused: [{ issueId: id, code: 'HOLD_WITHOUT_SAID' }],
    });
    expect(await stateOf(id)).toEqual({ held: stale, comments: 0 });
  });

  it('is refused by name when the same reason is to be commented, not looked up in the thread', async () => {
    const id = await heldRow(stale);
    const tally = await mod.writeReleaseHolds({
      issueIds: [id],
      holdFor: () => HOLD,
      authorId: ownerId,
      now: new Date(),
      commentOn: new Set([id]),
    });
    expect(tally).toMatchObject({ refused: [{ issueId: id, code: 'HOLD_WITHOUT_SAID' }] });
    expect(await stateOf(id)).toEqual({ held: stale, comments: 0 });
  });

  it('is not what a hold carrying `said` meets: that one is written and commented', async () => {
    const id = await heldRow({ ...stale, said: [] });
    const tally = await mod.writeReleaseHolds({
      issueIds: [id],
      holdFor: () => ({ ...HOLD, reason: 'every runner is rate limited' }),
      authorId: ownerId,
      now: new Date(),
    });
    expect(tally).toMatchObject({ written: 1, refused: [] });
    expect((await stateOf(id))?.comments).toBe(1);
  });
});
