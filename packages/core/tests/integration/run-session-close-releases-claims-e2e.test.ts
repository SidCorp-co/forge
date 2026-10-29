import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type Doc,
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

// ISS-737: closing a run gave its tree back and left the issue claim its run took (`forge claim`,
// under the id its tree held) live for the claim's whole duration, so the next run on the issue was
// refused on every write (catalog-fe ISS-39, adminhub-api ISS-32). The box names the id on the
// close; an `ended` close gives back what that id holds, and nothing else.

let say: (method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let deviceId = '';
const ids: Record<number, string> = {};

async function issue(seq: number, ownerId: string): Promise<void> {
  const [row] = (await db.execute(sql`
    INSERT INTO issues (project_id, iss_seq, title, status, created_by_id)
    VALUES (${projectId}, ${seq}, ${`issue ${seq}`}, 'open', ${ownerId})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  ids[seq] = String(row?.id);
}

/** A claim as the plugin's `forge claim` writes it, from this box. */
async function claim(seq: number, holder: string, from: string | null = deviceId): Promise<void> {
  const lease = {
    holder,
    agent: 'claude',
    pid: '4242',
    renewedAt: new Date().toISOString(),
    minutes: 90,
  };
  await db.execute(sql`
    INSERT INTO issue_work_state (issue_id, lease, lease_device_id)
    VALUES (${ids[seq]}, ${JSON.stringify(lease)}::jsonb, ${from})
    ON CONFLICT (issue_id) DO UPDATE SET lease = EXCLUDED.lease, lease_device_id = EXCLUDED.lease_device_id
  `);
}

async function leaseOf(seq: number): Promise<Doc | null> {
  const rows = (await db.execute(
    sql`SELECT lease FROM issue_work_state WHERE issue_id = ${ids[seq]}`,
  )) as unknown as Array<{ lease: Doc | null }>;
  return rows[0]?.lease ?? null;
}

async function openRun(seq: number): Promise<string> {
  const r = await say('POST', '/api/devices/me/run-sessions', {
    projectId,
    runId: crypto.randomUUID(),
    issueKeys: [`ISS-${seq}`],
    name: `ISS-${seq}`,
  });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const id = (r.json as Doc).sessionId ?? (r.json as Doc).id;
  expect(typeof id).toBe('string');
  return id as string;
}

const close = (session: string, body: Doc) =>
  say('POST', `/api/devices/me/run-sessions/${session}/close`, body);

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  deviceId = await createTestDevice(ownerId);
  await bindTestRunner(projectId, deviceId);
  for (const seq of [1, 2, 3, 4]) await issue(seq, ownerId);
  const box = (
    await mintPat({
      permissions: ['*'],
      userId: ownerId,
      name: 'box',
      deviceId,
      projectIds: [projectId],
    })
  ).plaintext;
  const as = requester(app, { box }) as (
    who: 'box',
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<Reply>;
  say = (method, path, body) => as('box', method, path, body);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('closing a run gives back the claims its id held', () => {
  it('frees the claim at once, marked as the run closing, and the next run takes it', async () => {
    const session = await openRun(1);
    await claim(1, 'iss-1-5c7c8139');
    const r = await close(session, { outcome: 'ended', claimHolders: ['iss-1-5c7c8139'] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const lease = await leaseOf(1);
    expect(lease?.holder, 'the closed run still holds its claim').toBe('');
    expect(lease?.releasedBy).toBe('run-close');
    expect(typeof lease?.released).toBe('string');
    expect((r.json as Doc).claimsReleased).toEqual(['ISS-1']);

    // The next run's claim is a write that takes the lease, and nothing holds the issue against it.
    const next = await openRun(1);
    const taken = await say('PATCH', `/api/issues/${ids[1]}`, {
      sessionContext: {
        lease: {
          holder: 'iss-1-0a1b2c3d',
          agent: 'claude',
          pid: '4242',
          renewedAt: new Date().toISOString(),
          minutes: 90,
        },
      },
    });
    expect(taken.status, JSON.stringify(taken.json)).toBe(200);
    expect((await leaseOf(1))?.holder).toBe('iss-1-0a1b2c3d');
    await close(next, { outcome: 'ended' });
  });

  it('leaves a claim another id holds, and one another box wrote', async () => {
    const otherBox = await createTestDevice((await createTestUser({ verified: true })).id);
    const session = await openRun(2);
    await claim(2, 'iss-2-11111111');
    await claim(3, 'iss-2-22222222', otherBox);
    const r = await close(session, {
      outcome: 'ended',
      claimHolders: ['iss-2-99999999', 'iss-2-22222222'],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((r.json as Doc).claimsReleased).toEqual([]);
    expect((await leaseOf(2))?.holder).toBe('iss-2-11111111');
    expect((await leaseOf(3))?.holder).toBe('iss-2-22222222');
  });

  it('gives nothing back on a close that is a death, nor on one naming no id', async () => {
    const died = await openRun(4);
    await claim(4, 'iss-4-33333333');
    expect((await close(died, { outcome: 'died', claimHolders: ['iss-4-33333333'] })).status).toBe(
      200,
    );
    expect((await leaseOf(4))?.holder).toBe('iss-4-33333333');
  });
});
