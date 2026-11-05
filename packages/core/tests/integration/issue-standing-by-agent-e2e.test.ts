/**
 * ISS-1001: the Issues list's Technical chip shows what agents found, so each row of the standing read
 * says whether an agent filed it, by `issues/creator.ts`'s rule: an agent account, or a person's
 * account writing through a paired box. Against real Postgres.
 *
 * @direct-test-of packages/core/src/issues/standing-read.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  seedIssueStatus,
} from '../helpers/factories.js';

let projectId = '';
let token = '';

beforeAll(async () => {
  testEnv();
  const owner = (await createTestUser({ verified: true })).id;
  const agent = (await createTestUser({ kind: 'agent' })).id;
  projectId = (await createTestProject(owner)).id;
  await addProjectMember(projectId, owner, 'admin');
  token = await userToken(owner);
  const at = new Date();
  const byPerson = await createTestIssue(projectId, owner, 1, { status: 'draft', createdAt: at });
  const byAgent = await createTestIssue(projectId, agent, 2, { status: 'draft', createdAt: at });
  const byBox = await createTestIssue(projectId, owner, 3, { status: 'draft', createdAt: at });
  const device = await createTestDevice(owner);
  await db.execute(sql`UPDATE issues SET created_by_device_id = ${device} WHERE id = ${byBox.id}`);
  for (const i of [byPerson, byAgent, byBox]) await seedIssueStatus(i.id, 'draft');
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('each standing row says whether an agent filed it', () => {
  it('reads an agent account and a paired box as an agent, and a person as a person', async () => {
    const res = await api(token, 'GET', `/api/projects/${projectId}/issues/standing?scope=all`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = (res.body as { issues: Array<{ key: string; byAgent: boolean }> }).issues;
    expect(Object.fromEntries(rows.map((r) => [r.key, r.byAgent]))).toEqual({
      'ISS-1': false,
      'ISS-2': true,
      'ISS-3': true,
    });
  });
});
