/**
 * ISS-576 (REQ-74 BC-5): a run its master holds is kept while its agent works, even once every issue
 * it holds is over (a release judge, whose issues its release closed). Its standing, read off core's
 * own rows through `GET /api/projects/:id/runs/standing`, names that cause and its master, who acts
 * next; while any issue it holds is not over it stands at work as before.
 *
 * @direct-test-of packages/core/src/runs/standing-live.ts
 * @direct-test-of packages/core/src/runs/facts.ts
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
  seedIssueStatus,
} from '../helpers/factories.js';
import { projectBuiltFrom } from '../helpers/pattern-world.js';

let projectId = '';
let box = '';
let reader = '';
const issueIds = new Map<number, string>();

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  const admin = await createTestUser({ verified: true });
  projectId = await projectBuiltFrom(admin.id, null);
  await addProjectMember(projectId, admin.id, 'admin');
  const deviceId = await createTestDevice(admin.id);
  await bindTestRunner(projectId, deviceId);
  box = (
    await mintPat({
      permissions: ['*'],
      userId: admin.id,
      name: 'box-held',
      deviceId,
      projectIds: [projectId],
    })
  ).plaintext;
  reader = await userToken(admin.id);
  for (const seq of [1, 2]) {
    const issue = await createTestIssue(projectId, admin.id, seq, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    issueIds.set(seq, issue.id);
  }
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

async function standingOf(runId: string): Promise<Doc> {
  const res = await api(reader, 'GET', `/api/projects/${projectId}/runs/standing`);
  expect(res.status).toBe(200);
  const item = ((res.body as Doc).items as Doc[]).find((i) => i.boxRunId === runId);
  if (!item) throw new Error(`runs/standing lists no run ${runId}`);
  return item;
}

async function closeIssue(seq: number): Promise<void> {
  const id = String(issueIds.get(seq));
  await db.execute(sql`UPDATE issues SET merged_at = now() WHERE id = ${id}`);
  await seedIssueStatus(id, 'closed');
}

describe('ISS-576 a live run whose every issue is over', () => {
  it('stands at work over open issues, still at work with one closed, and held on its master once all are over', async () => {
    const runId = randomUUID();
    const opened = await api(box, 'POST', '/api/devices/me/run-sessions', {
      projectId,
      runId,
      issueKeys: ['ISS-1', 'ISS-2'],
      name: 'judge',
    });
    expect([opened.status, JSON.stringify(opened.body)]).toEqual([200, expect.any(String)]);

    const working = await standingOf(runId);
    expect(working.waitingOn.kind).not.toBe('master');
    expect(working.rule).not.toContain('held');

    await closeIssue(1);
    const oneLeft = await standingOf(runId);
    expect(oneLeft.waitingOn.kind).not.toBe('master');

    await seedIssueStatus(String(issueIds.get(2)), 'dropped');
    const held = await standingOf(runId);
    expect(held.state).toBe('running');
    expect(held.rule).toBe('held: ISS-1, ISS-2 over, its agent works on');
    expect(held.waitingOn).toMatchObject({
      kind: 'master',
      who: 'Master',
      act: 'close the run once its agent reports',
      rule: 'held: every issue it holds is over; its master closes it',
    });
    expect(held.waitingOn.says.rule).toMatchObject({ key: 'runs.rule.heldIssuesOver' });
  });
});
