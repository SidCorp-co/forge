import { MASTER_NUDGE_REFRESH_SECONDS } from '@forge/contracts/master-verdict';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

// ADR 0009: the box sends its newest decisive record and core decides freshness, report and clear.

let say: (method: string, path: string, body?: unknown) => Promise<Reply>;
let runnerId = '';
let limitOf: () => Promise<{ limitReason: string | null; limitDetail: string | null }>;
let holdOf: () => Promise<Hold>;
let setHold: (hold: {
  refusedAgo: number;
  nextTryAgo: number;
  printedAgo: number;
}) => Promise<void>;

interface Hold {
  nextTry: Date | null;
  refusedAt: Date | null;
  printedReset: Date | null;
  /** The dispatch filter's own reading (runners/liveness-sql.ts:runnerUnlimited). */
  eligible: boolean;
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  const { db } = await import('../../src/db/client.js');
  const { runners } = await import('../../src/db/schema.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  const projectId = (await createTestProject(ownerId)).id;
  const deviceId = await createTestDevice(ownerId);
  runnerId = await bindTestRunner(projectId, deviceId);
  const asDevice = requester(app, {
    box: (
      await mintPat({
        permissions: ['*'],
        userId: ownerId,
        name: 'box',
        deviceId,
        projectIds: [projectId],
      })
    ).plaintext,
  });
  say = (method, path, body) => asDevice('box', method, path, body);
  limitOf = async () => {
    const [row] = await db
      .select({ limitReason: runners.limitReason, limitDetail: runners.limitDetail })
      .from(runners)
      .where(eq(runners.id, runnerId));
    if (!row) throw new Error(`the bound runner ${runnerId} has no row`);
    return row;
  };
  const { runnerUnlimited } = await import('../../src/runners/liveness-sql.js');
  const asDate = (v: unknown) => (v === null ? null : new Date(v as string));
  holdOf = async () => {
    const [row] = [
      ...(await db.execute<Record<string, unknown>>(sql`
        SELECT r.rate_limited_until, to_jsonb(r) -> 'limit_refused_at' AS refused_at,
               to_jsonb(r) -> 'limit_printed_reset_at' AS printed_reset,
               (${runnerUnlimited('r')}) AS eligible
          FROM runners r WHERE r.id = ${runnerId}`)),
    ];
    if (!row) throw new Error(`the bound runner ${runnerId} has no row`);
    return {
      nextTry: asDate(row.rate_limited_until),
      refusedAt: asDate(row.refused_at ?? null),
      printedReset: asDate(row.printed_reset ?? null),
      eligible: row.eligible === true,
    };
  };
  setHold = async ({ refusedAgo, nextTryAgo, printedAgo }) => {
    await db.execute(sql`
      UPDATE runners
         SET limit_refused_at = now() - make_interval(secs => ${refusedAgo}),
             rate_limited_until = now() - make_interval(secs => ${nextTryAgo}),
             limit_printed_reset_at = now() - make_interval(secs => ${printedAgo})
       WHERE id = ${runnerId}`);
  };
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const refused = (agoSeconds: number, detail = 'You hit your limit', resetsInSeconds = 3600) => ({
  kind: 'refused',
  agoSeconds,
  reason: 'usage_limit',
  resetsInSeconds,
  detail,
});

const near = (at: Date | null, expected: number, slackMs = 5_000) => {
  expect(at, 'a time was recorded').not.toBeNull();
  expect(Math.abs((at as Date).getTime() - expected)).toBeLessThan(slackMs);
};
const REFRESH_MS = MASTER_NUDGE_REFRESH_SECONDS * 1000;
const HOURS_3 = 3 * 60 * 60;

const record = (body: unknown) => say('POST', '/api/devices/me/limit/record', { record: body });

describe('POST /api/devices/me/limit/record', () => {
  it('reports a fresh refusal onto the runner row, and holds it on a repeat', async () => {
    expect(ok(await record(refused(30))).outcome).toBe('reported');
    expect(await limitOf()).toEqual({
      limitReason: 'usage_limit',
      limitDetail: 'You hit your limit',
    });
    expect(ok(await record(refused(31))).outcome).toBe('held');
  });

  it('lifts it on a turn the account answered within the nudge refresh, not after', async () => {
    expect(ok(await record({ kind: 'worked', agoSeconds: 301 })).outcome).toBe('nothing');
    expect((await limitOf()).limitReason).toBe('usage_limit');
    expect(ok(await record({ kind: 'worked', agoSeconds: 20 })).outcome).toBe('cleared');
    expect((await limitOf()).limitReason).toBeNull();
  });

  it('leaves a refusal past the freshness window, or past its next try, unreported', async () => {
    expect(ok(await record(refused(20 * 60 + 1, 'old'))).outcome).toBe('stale');
    expect(ok(await record(refused(MASTER_NUDGE_REFRESH_SECONDS + 1, 'old'))).outcome).toBe(
      'stale',
    );
    expect((await limitOf()).limitReason).toBeNull();
  });

  it('refuses a malformed body by name instead of answering 200', async () => {
    const bad = await record({ kind: 'refused', agoSeconds: 'soon', reason: 'usage_limit' });
    expect(bad.status, JSON.stringify(bad.json)).toBe(400);
    const unknown = await record({ kind: 'sulking' });
    expect(unknown.status).toBe(400);
    const bare = await say('POST', '/api/devices/me/limit/record', {
      kind: 'worked',
      agoSeconds: 1,
    });
    expect(bare.status).toBe(400);
    expect((await limitOf()).limitReason).toBeNull();
  });
});

// ISS-276 / FB-87: refused at 16:02Z with "resets 2:30am (Asia/Ho_Chi_Minh)" (19:30Z), answered at
// 16:42Z. The printed time is what the account said; the runner is held until the next nudge.
describe('a refusal holds the runner until its next try, and keeps the printed reset as a claim', () => {
  it('a limit that recovers before the printed time frees the runner at the answered turn', async () => {
    expect(ok(await record(refused(30, 'resets 2:30am (Asia/Ho_Chi_Minh)', HOURS_3))).outcome).toBe(
      'reported',
    );
    const held = await holdOf();
    near(held.nextTry, Date.now() - 30_000 + REFRESH_MS);
    near(held.refusedAt, Date.now() - 30_000);
    near(held.printedReset, Date.now() + HOURS_3 * 1000);
    expect(held.eligible).toBe(false);

    expect(ok(await record({ kind: 'worked', agoSeconds: 5 })).outcome).toBe('cleared');
    expect(await holdOf()).toEqual({
      nextTry: null,
      refusedAt: null,
      printedReset: null,
      eligible: true,
    });
  });

  it('a limit that outlasts the printed time is held again by each fresh refusal, to its own next try', async () => {
    expect(ok(await record(refused(20, 'resets 1am (UTC)', 60))).outcome).toBe('reported');
    await setHold({ refusedAgo: 6 * 60, nextTryAgo: 60, printedAgo: 4 * 60 });
    const due = await holdOf();
    expect(due.eligible, 'its next try has come, so the runner may be tried').toBe(true);

    expect(ok(await record(refused(10, 'resets 3am (UTC)', HOURS_3))).outcome).toBe('reported');
    const again = await holdOf();
    near(again.refusedAt, Date.now() - 10_000);
    near(again.nextTry, Date.now() - 10_000 + REFRESH_MS);
    near(again.printedReset, Date.now() + HOURS_3 * 1000);
    expect(again.eligible).toBe(false);
    expect(ok(await record(refused(12, 'resets 3am (UTC)', HOURS_3))).outcome).toBe('held');

    expect(ok(await record({ kind: 'worked', agoSeconds: 1 })).outcome).toBe('cleared');
    expect((await holdOf()).eligible).toBe(true);
  });

  it('the old refusal a box sends again after its next try neither restarts nor extends the hold', async () => {
    expect(ok(await record(refused(MASTER_NUDGE_REFRESH_SECONDS + 30))).outcome).toBe('stale');
    expect(await holdOf()).toMatchObject({ nextTry: null, eligible: true });
  });
});
