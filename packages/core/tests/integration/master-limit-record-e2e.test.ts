import { eq } from 'drizzle-orm';
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
    box: (await mintPat({ userId: ownerId, name: 'box', deviceId, projectIds: [projectId] }))
      .plaintext,
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
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const refused = (agoSeconds: number, detail = 'You hit your limit') => ({
  kind: 'refused',
  agoSeconds,
  reason: 'usage_limit',
  resetsInSeconds: 3600,
  detail,
});

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

  it('leaves a refusal past the freshness window unreported', async () => {
    expect(ok(await record(refused(20 * 60 + 1, 'old'))).outcome).toBe('stale');
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
