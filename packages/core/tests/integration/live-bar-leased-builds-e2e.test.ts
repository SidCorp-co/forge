/**
 * ISS-1102: a project in direct mode builds through its master's own subagents under an issue lease,
 * with no runner job and no run record. On forge-dev (QA on dev.577) the Issues header read "Nothing
 * running" beside three rows "In progress · Build", each leased by the master. The read behind the
 * bar, `GET /api/projects/:id/runs/standing`, now serves those leased builds beside the runs: a live
 * lease at a moving status with no live run over it, named as the master's where the lease was
 * written from the master's box. It never names a build no live lease holds, and never twice a build
 * a run already lists.
 *
 * @direct-test-of packages/core/src/runs/leased-builds.ts
 * @direct-test-of packages/core/src/runs/read.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestUser,
} from '../helpers/factories.js';
import { projectBuiltFrom } from '../helpers/pattern-world.js';

const LIFECYCLE = { 'X-Forge-Lifecycle': '10' };
let projectId = '';
let masterBox = '';
let otherBox = '';
let reader = '';
const ids = new Map<number, string>();

async function boxPat(userId: string, deviceId: string, name: string): Promise<string> {
  const { mintPat } = await import('../../src/credentials/pat.js');
  return (await mintPat({ permissions: ['*'], userId, name, deviceId, projectIds: [projectId] }))
    .plaintext;
}

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const admin = await createTestUser({ verified: true });
  projectId = await projectBuiltFrom(admin.id, null);
  await addProjectMember(projectId, admin.id, 'admin');
  const masterDevice = await createTestDevice(admin.id);
  const otherDevice = await createTestDevice(admin.id);
  await bindTestRunner(projectId, masterDevice);
  masterBox = await boxPat(admin.id, masterDevice, 'box-master');
  otherBox = await boxPat(admin.id, otherDevice, 'box-other');
  reader = await userToken(admin.id);
  const placed = await api(masterBox, 'POST', '/api/devices/me/master-session', {
    projectId,
    name: 'forge-master-test',
    maxJobPanes: 2,
  });
  expect(placed.status, JSON.stringify(placed.body)).toBe(200);
  for (const [seq, status] of [
    [1, 'in_progress'],
    [2, 'in_progress'],
    [3, 'in_progress'],
    [4, 'in_progress'],
    [5, 'dropped'],
    [6, 'in_progress'],
  ] as const) {
    const issue = await createTestIssue(projectId, admin.id, seq, {
      status,
      createdAt: new Date(),
    });
    ids.set(seq, issue.id);
  }
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const id = (seq: number) => String(ids.get(seq));

async function lease(seq: number, token: string, holder: string, minutes = 300): Promise<void> {
  const body = {
    sessionContext: { lease: { holder, renewedAt: new Date().toISOString(), minutes } },
  };
  const res = await api(token, 'PATCH', `/api/issues/${id(seq)}`, body, LIFECYCLE);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function atStep(seq: number, minutesAgo: number): Promise<void> {
  await db.execute(sql`
    UPDATE issue_work_state
       SET step = 'build', step_started_at = now() - make_interval(mins => ${minutesAgo})
     WHERE issue_id = ${id(seq)}`);
}

async function live(): Promise<Doc> {
  const res = await api(reader, 'GET', `/api/projects/${projectId}/runs/standing?scope=live`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Doc;
}

describe('ISS-1102 the read behind the live bar serves leased builds beside the runs', () => {
  it('names a leased in_progress issue with no run as running, its holder and step, the master its own', async () => {
    const before = await live();
    expect(before.items).toEqual([]);
    expect(before.leased).toEqual([]);

    await lease(1, masterBox, 'forge-master-box');
    await atStep(1, 17);
    await lease(2, otherBox, 'someone-else');
    await atStep(2, 34);

    const read = await live();
    expect(read.items).toEqual([]);
    expect(read.leased).toEqual([
      {
        issue: { key: 'ISS-1', title: 'issue 1', status: 'in_progress' },
        step: 'build',
        stepStartedAt: expect.any(String),
        holder: 'forge-master-box',
        byMaster: true,
        expiresAt: expect.any(String),
      },
      {
        issue: { key: 'ISS-2', title: 'issue 2', status: 'in_progress' },
        step: 'build',
        stepStartedAt: expect.any(String),
        holder: 'someone-else',
        byMaster: false,
        expiresAt: expect.any(String),
      },
    ]);
  });

  it('never names a lease that lapsed, an issue that is over, or an issue with no lease', async () => {
    await lease(3, masterBox, 'forge-master-box', 60);
    await db.execute(sql`
      UPDATE issue_work_state
         SET lease = jsonb_set(lease, '{renewedAt}', to_jsonb((now() - interval '2 hours')::text))
       WHERE issue_id = ${id(3)}`);
    await lease(5, masterBox, 'forge-master-box');
    const keys = ((await live()).leased as Doc[]).map((b) => b.issue.key);
    expect(keys).not.toContain('ISS-3');
    expect(keys).not.toContain('ISS-4');
    expect(keys).not.toContain('ISS-5');
  });

  it('leaves to the runs a leased issue a live run already holds, so it is said once', async () => {
    await lease(6, masterBox, 'forge-master-box');
    const runId = randomUUID();
    const opened = await api(masterBox, 'POST', '/api/devices/me/run-sessions', {
      projectId,
      runId,
      issueKeys: ['ISS-6'],
      name: 'builder',
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const read = await live();
    expect((read.items as Doc[]).some((r) => r.boxRunId === runId)).toBe(true);
    expect((read.leased as Doc[]).map((b) => b.issue.key)).toEqual(['ISS-1', 'ISS-2']);
  });
});
