/**
 * The Issues list's Owner column names a person (ISS-1072): on dev, 2026-11-07, issues the project's
 * agent filed from the box read "forge", the agent's handle, beside its mark. An unassigned issue filed
 * from a box is owned by the person who owns the box; one filed with no box keeps its creator, and an
 * assignee always owns it.
 *
 * @direct-test-of packages/core/src/issues/standing-owner.ts
 * @direct-test-of packages/core/src/issues/standing-read.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

let projectId = '';
let ownerId = '';
let agentId = '';
let token = '';

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  agentId = (await createTestUser({ kind: 'agent' })).id;
  await db.execute(sql`UPDATE users SET display_name = 'Lan' WHERE id = ${ownerId}`);
  await db.execute(sql`UPDATE users SET display_name = 'forge' WHERE id = ${agentId}`);
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

async function filedByAgent(seq: number, box: string | null) {
  const issue = await createTestIssue(projectId, ownerId, seq, {
    status: 'open',
    createdAt: new Date(),
  });
  await db.execute(sql`
    UPDATE issues SET created_by_id = ${agentId}, created_by_device_id = ${box} WHERE id = ${issue.id}`);
  return issue.key;
}

async function ownerOf(key: string): Promise<Doc> {
  const res = await api(token, 'GET', `/api/projects/${projectId}/issues/standing/${key}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.standing as Doc).owner as Doc;
}

describe('the owner an issue names (ISS-1072)', () => {
  it('is the person who owns the box an agent filed it from, by name', async () => {
    const box = await createTestDevice(ownerId);
    expect(await ownerOf(await filedByAgent(1, box))).toMatchObject({
      id: ownerId,
      name: 'Lan',
      kind: 'human',
    });
  });

  it('is the agent that filed it where no box did', async () => {
    expect(await ownerOf(await filedByAgent(2, null))).toMatchObject({
      id: agentId,
      kind: 'agent',
    });
  });
});
