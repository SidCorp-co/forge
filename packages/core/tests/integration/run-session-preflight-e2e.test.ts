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
  seedIssueStatus,
} from '../helpers/factories.js';

// A master's `run declare` writes the box's row without core, so a dispatch on an unstarted issue a
// live blocks edge holds was accepted and then refused at every sweep. The preflight asks core the
// open's own question at declare time, writing nothing.

let say: (method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
const ids: Record<number, string> = {};

async function issue(seq: number, status: string, ownerId: string): Promise<void> {
  const [row] = (await db.execute(sql`
    INSERT INTO issues (project_id, iss_seq, title, status, created_by_id)
    VALUES (${projectId}, ${seq}, ${`issue ${seq}`}, 'open', ${ownerId})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  ids[seq] = String(row?.id);
  if (status !== 'open') await seedIssueStatus(ids[seq] as string, status);
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const deviceId = await createTestDevice(ownerId);
  await bindTestRunner(projectId, deviceId);
  await issue(1, 'in_progress', ownerId);
  await issue(2, 'open', ownerId);
  await issue(3, 'open', ownerId);
  await db.execute(sql`
    INSERT INTO issue_dependencies (project_id, from_issue_id, to_issue_id, kind)
    VALUES (${projectId}, ${ids[1]}, ${ids[2]}, 'blocks')
  `);
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

const preflight = (keys: string[]) =>
  say('POST', '/api/devices/me/run-sessions/preflight', { projectId, issueKeys: keys });
const codes = (r: Reply): string[] =>
  ((r.json as Doc).error?.refusals ?? []).map((x: Doc) => x.code);

describe('run-session preflight', () => {
  it('refuses a blocked issue by name, naming the edge and what it waits on', async () => {
    const r = await preflight(['ISS-2']);
    expect(r.status).toBe(422);
    expect(codes(r)).toContain('ISSUE_BLOCKED');
    const detail = JSON.stringify(r.json);
    expect(detail).toContain('ISS-1');
    expect(detail).toContain('in_progress');
  });

  it('answers an unblocked issue and writes no run or session', async () => {
    const before = (await db.execute(
      sql`SELECT count(*)::int AS n FROM agent_sessions WHERE project_id = ${projectId}`,
    )) as unknown as Array<{ n: number }>;
    const r = await preflight(['ISS-3']);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    const after = (await db.execute(
      sql`SELECT count(*)::int AS n FROM agent_sessions WHERE project_id = ${projectId}`,
    )) as unknown as Array<{ n: number }>;
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it('refuses one blocked member of a group by name', async () => {
    const r = await preflight(['ISS-3', 'ISS-2']);
    expect(codes(r)).toContain('ISSUE_BLOCKED');
  });

  it('refuses the same issue at the open, so the preflight and the open say one thing', async () => {
    const r = await say('POST', '/api/devices/me/run-sessions', {
      projectId,
      runId: crypto.randomUUID(),
      issueKeys: ['ISS-2'],
      name: 'ISS-2',
    });
    expect(codes(r)).toContain('ISSUE_BLOCKED');
  });
});
