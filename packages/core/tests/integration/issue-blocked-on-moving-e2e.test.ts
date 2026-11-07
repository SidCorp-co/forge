/**
 * An issue behind a blocker that is moving waits on it; it is stuck only when that blocker is itself
 * stuck or nobody holds it (ISS-1072; on dev, 2026-11-07, ISS-1078 read `stuck | ISS-1072 · running`
 * while a run held ISS-1072). The list and the issue's own read agree, the single read reading its
 * blocker's own standing though the blocker is not among the rows it was asked for.
 *
 * @direct-test-of packages/core/src/issues/standing-read.ts
 * @direct-test-of packages/core/src/issues/standing-groups.ts
 * @direct-test-of packages/core/src/issues/standing-held.ts
 * @direct-test-of packages/core/src/issues/standing.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestIssue, createTestProject, createTestUser } from '../helpers/factories.js';

let projectId = '';
let ownerId = '';
let token = '';

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** `blocker` at in_progress, held by a live run where `held`, blocking `dependent` at open. */
async function pair(blockerSeq: number, held: boolean) {
  const at = new Date(Date.now() - 3 * 86_400_000);
  const blocker = await createTestIssue(projectId, ownerId, blockerSeq, {
    status: 'in_progress',
    createdAt: at,
  });
  const dependent = await createTestIssue(projectId, ownerId, blockerSeq + 1, {
    status: 'open',
    createdAt: at,
  });
  if (held) {
    const lease = {
      holder: `iss-${blockerSeq}-run`,
      renewedAt: new Date().toISOString(),
      minutes: 60,
    };
    await db.execute(sql`
      INSERT INTO issue_work_state (issue_id, step, step_started_at, lease, updated_at)
      VALUES (${blocker.id}, 'build', now(), ${JSON.stringify(lease)}::jsonb, now())`);
  }
  await db.execute(sql`
    INSERT INTO issue_dependencies (project_id, from_issue_id, to_issue_id, kind)
    VALUES (${projectId}, ${blocker.id}, ${dependent.id}, 'blocks')`);
  return { blocker: blocker.key, dependent: dependent.key };
}

async function listed(key: string): Promise<Doc> {
  const res = await api(token, 'GET', `/api/projects/${projectId}/issues/standing`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const row = (res.body.issues as Doc[]).find((i) => i.key === key);
  expect(row, `${key} is listed`).toBeDefined();
  return (row as Doc).standing as Doc;
}

async function own(key: string): Promise<Doc> {
  const res = await api(token, 'GET', `/api/projects/${projectId}/issues/standing/${key}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.standing as Doc;
}

describe('an issue behind a live blocker (ISS-1072)', () => {
  it('waits on a blocker a run holds: queued on the list and on its own read, the blocker named', async () => {
    const { blocker, dependent } = await pair(10, true);
    expect((await listed(blocker)).attentionGroup).toBe('moving');
    for (const s of [await listed(dependent), await own(dependent)]) {
      expect(s.attentionGroup).toBe('queued');
      expect(s.times.stuck).toBeNull();
      expect(s.waitingOn).toMatchObject({ kind: 'issue', ref: blocker });
    }
  });

  it('is stuck behind a blocker nobody holds, on the list and on its own read', async () => {
    const { blocker, dependent } = await pair(20, false);
    expect((await listed(blocker)).attentionGroup).toBe('stuck');
    for (const s of [await listed(dependent), await own(dependent)]) {
      expect(s.attentionGroup).toBe('stuck');
      expect(s.times.stuck).toMatchObject({ code: 'blocked' });
    }
  });
});
