/**
 * ISS-576 round 2 (REQ-74 BC-5): a run its master declares over issues that are already closed, a
 * release judge over the issues its release closed, gets a run session. Before, core refused the open
 * `ISSUE_AT_REST`, the box re-sent it every sweep for the run's whole life, and with no session core
 * had no run row: `runs/standing/:runId` answered 404 and the Runs list left it out. A judge takes no
 * claim on an issue, so such a run opens taking no lease and restarting no step, and its standing
 * names the closed issues as why it is held and its master as who acts next. A run over a parked
 * issue, or over a closed issue beside one still in work, is a take and still refused by name.
 *
 * @direct-test-of packages/core/src/devices/run-session.ts
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

let projectId = '';
let box = '';
let reader = '';
const ids = new Map<number, string>();

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
      name: 'box-judge',
      deviceId,
      projectIds: [projectId],
    })
  ).plaintext;
  reader = await userToken(admin.id);
  const seeded: Array<[number, string]> = [
    [1, 'closed'],
    [2, 'closed'],
    [3, 'needs_info'],
    [4, 'open'],
    [5, 'dropped'],
  ];
  for (const [seq, status] of seeded) {
    const issue = await createTestIssue(projectId, admin.id, seq, {
      status,
      createdAt: new Date(),
      mergedAt: status === 'closed' ? new Date() : null,
      ...(status === 'needs_info' ? { waitingKind: 'needs_answer' } : {}),
    });
    ids.set(seq, issue.id);
  }
  const master = await api(box, 'POST', '/api/devices/me/master-session', {
    projectId,
    name: 'forge-master-judge',
    maxJobPanes: 2,
  });
  expect([master.status, JSON.stringify(master.body)]).toEqual([200, expect.any(String)]);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const declare = (runId: string, issueKeys: string[]) =>
  api(box, 'POST', '/api/devices/me/run-sessions', {
    projectId,
    runId,
    issueKeys,
    name: `judge-${runId.slice(0, 4)}`,
  });
const preflight = (issueKeys: string[]) =>
  api(box, 'POST', '/api/devices/me/run-sessions/preflight', { projectId, issueKeys });
const codes = (body: unknown): string[] =>
  (((body as Doc).error?.refusals ?? []) as Doc[]).map((r) => String(r.code));

async function leasesOn(keys: string[]): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM issue_leases
     WHERE project_id = ${projectId} AND issue_key IN (${sql.join(
       keys.map((k) => sql`${k}`),
       sql`, `,
     )})
  `)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? -1;
}

describe('ISS-576 a run declared over issues already closed', () => {
  it('opens, takes no lease, and stands held by id and in the Runs list, its master acting next', async () => {
    const pre = await preflight(['ISS-1', 'ISS-2']);
    expect(
      [pre.status, codes(pre.body)],
      'the declare-time question refuses a judge over closed issues',
    ).toEqual([200, []]);

    const runId = randomUUID();
    const opened = await declare(runId, ['ISS-1', 'ISS-2']);
    expect(
      [opened.status, codes(opened.body)],
      'core refused the session open of a judge run over closed issues',
    ).toEqual([200, []]);
    expect(await leasesOn(['ISS-1', 'ISS-2'])).toBe(0);

    const again = await declare(runId, ['ISS-1', 'ISS-2']);
    expect(again.status).toBe(200);
    expect((again.body as Doc).sessionId).toBe((opened.body as Doc).sessionId);

    const byId = await api(reader, 'GET', `/api/projects/${projectId}/runs/standing/${runId}`);
    expect(byId.status, JSON.stringify(byId.body)).toBe(200);
    const run = (byId.body as Doc).run as Doc;
    expect(run.state).toBe('running');
    expect(run.rule).toBe('held: ISS-1, ISS-2 over, its agent works on');
    expect(run.waitingOn).toMatchObject({
      kind: 'master',
      who: 'forge-master-judge',
      act: 'close the run once its agent reports',
      rule: 'held: every issue it holds is over; its master closes it',
    });

    const list = await api(reader, 'GET', `/api/projects/${projectId}/runs/standing`);
    expect(list.status).toBe(200);
    const row = ((list.body as Doc).items as Doc[]).find((i) => i.boxRunId === runId);
    expect(row, 'the Runs list omits the judge run').toBeDefined();
    expect(row?.waitingOn?.kind).toBe('master');
  });

  it('opens over a dropped issue alone the same way', async () => {
    const opened = await declare(randomUUID(), ['ISS-5']);
    expect([opened.status, codes(opened.body)]).toEqual([200, []]);
    expect(await leasesOn(['ISS-5'])).toBe(0);
  });

  it('still refuses a parked issue by name, at the preflight and at the open', async () => {
    const pre = await preflight(['ISS-3']);
    expect([pre.status, codes(pre.body)]).toEqual([422, ['ISSUE_AT_REST']]);
    expect(JSON.stringify(pre.body)).toContain('`needs_info`');
    const opened = await declare(randomUUID(), ['ISS-3']);
    expect(codes(opened.body)).toEqual(['ISSUE_AT_REST']);
  });

  it('still refuses a closed issue declared beside one in work, a take on the closed one', async () => {
    const opened = await declare(randomUUID(), ['ISS-4', 'ISS-1']);
    expect(codes(opened.body)).toEqual(['ISSUE_AT_REST']);
    expect(JSON.stringify(opened.body)).toContain('ISS-1');
    expect(await leasesOn(['ISS-4'])).toBe(0);
  });

  it('a build over an issue in work still takes its lease', async () => {
    const opened = await declare(randomUUID(), ['ISS-4']);
    expect([opened.status, codes(opened.body)]).toEqual([200, []]);
    expect(await leasesOn(['ISS-4'])).toBe(1);
  });
});
