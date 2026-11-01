/**
 * ISS-735 (FB-327): a judge of a shipped requirement at the requirement could not be declared, since
 * a run took at least one issue, and the only issue near REQ-76 was held by another judge. A run
 * declared with a judging role over a requirement and no issue now opens, taking no lease; a builder
 * over a requirement, a requirement beside issues, and a requirement the project does not hold are
 * refused by name, and a run with neither is refused as before.
 *
 * @direct-test-of packages/core/src/devices/run-requirement.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestRequirement,
  createTestUser,
} from '../helpers/factories.js';
import { projectBuiltFrom } from '../helpers/pattern-world.js';

let projectId = '';
let box = '';

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
      name: 'box-req-judge',
      deviceId,
      projectIds: [projectId],
    })
  ).plaintext;
  await createTestRequirement(projectId, 76, 'A shipped capability');
  await createTestIssue(projectId, admin.id, 1, { status: 'open', createdAt: new Date() });
  const master = await api(box, 'POST', '/api/devices/me/master-session', {
    projectId,
    name: 'forge-master-req',
    maxJobPanes: 2,
  });
  expect([master.status, JSON.stringify(master.body)]).toEqual([200, expect.any(String)]);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const declare = (body: Record<string, unknown>) =>
  api(box, 'POST', '/api/devices/me/run-sessions', {
    projectId,
    runId: randomUUID(),
    name: 'judge-req',
    ...body,
  });
const preflight = (body: Record<string, unknown>) =>
  api(box, 'POST', '/api/devices/me/run-sessions/preflight', { projectId, ...body });
const codes = (body: unknown): string[] =>
  (((body as Doc).error?.refusals ?? []) as Doc[]).map((r) => String(r.code));

describe('ISS-735 a judge run declared over a requirement', () => {
  it('opens with no issue and no lease, the requirement on its run', async () => {
    const pre = await preflight({ issueKeys: [], requirement: 'REQ-76', role: 'qa' });
    expect([pre.status, codes(pre.body)]).toEqual([200, []]);
    const opened = await declare({ issueKeys: [], requirement: 'req-76', role: 'qa' });
    expect([opened.status, JSON.stringify(opened.body)]).toEqual([200, expect.any(String)]);
    const [run] = (await db.execute(sql`
      SELECT metadata ->> 'runRequirement' AS requirement FROM pipeline_runs
       WHERE id = ${(opened.body as Doc).runId}`)) as unknown as Array<{ requirement: string }>;
    expect(run?.requirement).toBe('REQ-76');
    const [leases] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM issue_leases WHERE project_id = ${projectId}`)) as unknown as Array<{
      n: number;
    }>;
    expect(leases?.n).toBe(0);
  });

  it('refuses a builder over a requirement, and a requirement beside an issue, by name', async () => {
    for (const body of [
      { issueKeys: [], requirement: 'REQ-76', role: 'runner' },
      { issueKeys: [], requirement: 'REQ-76' },
      { issueKeys: ['ISS-1'], requirement: 'REQ-76', role: 'qa' },
    ]) {
      const res = await declare(body);
      expect([res.status, codes(res.body)], JSON.stringify(body)).toEqual([
        422,
        ['RUN_REQUIREMENT_NOT_JUDGED'],
      ]);
    }
  });

  it('refuses a requirement the project does not hold, and a run with neither', async () => {
    const unknown = await preflight({ issueKeys: [], requirement: 'REQ-77', role: 'qa' });
    expect(codes(unknown.body)).toEqual(['RUN_REQUIREMENT_UNKNOWN']);
    const neither = await declare({ issueKeys: [], role: 'qa' });
    expect([neither.status, codes(neither.body)]).toEqual([422, ['RUN_SESSION_REFUSED']]);
  });
});
