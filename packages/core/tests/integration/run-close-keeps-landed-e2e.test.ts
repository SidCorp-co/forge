/**
 * A run's end hands back its lease and nothing else: it never moves an issue back past a merge mark
 * that stands (coordinator ruling 2026-10-26). adminhub-fe ISS-50: its merge was recorded at
 * 8ab74c9f while its builder's run held it at `in_progress`, and 32 s later that run ended and the
 * hand-back returned it to `open`, landed work reading as never started. The return is skipped and
 * the issue says why (`issue.handBackKept`). Work with no mark, and a mark the issue was reopened
 * after, are still handed back. Through the box's own open and close, against real Postgres.
 *
 * @direct-test-of packages/core/src/devices/run-issue-return.ts
 * @direct-test-of packages/core/src/devices/run-session.ts
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
  createTestUser,
  rows,
  seedIssueStatus,
} from '../helpers/factories.js';
import { projectBuiltFrom } from '../helpers/pattern-world.js';

const LANDING = '8ab74c9f1f226a87c6f39781980ff9365b53beca';

let projectId = '';
let adminId = '';
let box = '';
let seq = 0;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  adminId = (await createTestUser({ verified: true })).id;
  projectId = await projectBuiltFrom(adminId, null);
  const deviceId = await createTestDevice(adminId);
  await addProjectMember(projectId, adminId, 'admin');
  await bindTestRunner(projectId, deviceId);
  box = (
    await mintPat({
      permissions: ['*'],
      userId: adminId,
      name: 'box-hand-back',
      deviceId,
      projectIds: [projectId],
    })
  ).plaintext;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** A builder's run over a fresh issue at `from`, the issue then claimed to `in_progress`. */
async function building(from: 'open' | 'reopen') {
  seq += 1;
  const issue = await createTestIssue(projectId, adminId, seq, {
    status: from,
    createdAt: new Date(Date.now() - 3_600_000),
  });
  const res = await api(box, 'POST', '/api/devices/me/run-sessions', {
    projectId,
    runId: randomUUID(),
    issueKeys: [issue.key],
    name: issue.key,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await seedIssueStatus(issue.id, 'in_progress');
  return { ...issue, sessionId: String((res.body as Doc).sessionId) };
}

/** The issue's merge recorded at `LANDING`, as `recordIssueMerge` stamps it. */
async function merged(issueId: string, at = new Date()) {
  await db.execute(sql`
    UPDATE issues SET merged_at = ${at.toISOString()}::timestamptz, merged_commit_sha = ${LANDING}, merged_target = 'release/stg'
     WHERE id = ${issueId}`);
}

const closed = (sessionId: string) =>
  api(box, 'POST', `/api/devices/me/run-sessions/${sessionId}/close`, { outcome: 'ended' });

const statusOf = async (issueId: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${issueId}`))[0]?.status;

const kept = (issueId: string) =>
  rows<{ payload: Doc }>(sql`
    SELECT payload FROM activity_log WHERE issue_id = ${issueId} AND action = 'issue.handBackKept'`);

describe("a run's end over work merged while it held it (adminhub-fe ISS-50)", () => {
  it('keeps the issue where it stands and says why on the issue', async () => {
    const issue = await building('open');
    await merged(issue.id);

    const res = await closed(issue.sessionId);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issue.id)).toBe('in_progress');
    const [record, ...more] = await kept(issue.id);
    expect(more).toEqual([]);
    expect(record?.payload).toMatchObject({
      status: 'in_progress',
      wouldReturnTo: 'open',
      mergedCommitSha: LANDING,
    });
    expect(String(record?.payload.reason)).toContain(
      `its work landed at ${LANDING}, so it stays at in_progress rather than going back to open: a run's end hands back its lease and never undoes a landing`,
    );
  });
});

describe("a run's end over work that did not land", () => {
  it('still hands an unmerged issue back to where its run took it from', async () => {
    const issue = await building('open');

    expect((await closed(issue.sessionId)).status).toBe(200);

    expect(await statusOf(issue.id)).toBe('open');
    expect(await kept(issue.id)).toEqual([]);
  });

  it('still hands a reopened issue back to reopen: its mark is the round a failing verdict sent back', async () => {
    const issue = await building('reopen');
    await merged(issue.id, new Date(Date.now() - 7_200_000));
    await db.execute(sql`
      INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, source, actor_type, actor_agency, created_at)
      VALUES ('issue', ${issue.id}, 'awaiting_release', 'reopen', 'issues', 'user', 'human', now() - interval '1 hour')`);

    expect((await closed(issue.sessionId)).status).toBe(200);

    expect(await statusOf(issue.id)).toBe('reopen');
    expect(await kept(issue.id)).toEqual([]);
  });
});
