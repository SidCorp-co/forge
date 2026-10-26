/**
 * A verdict recorded from a box with no session named is the builder's where a session that built
 * the issue was live on that box (`issues/built-by.ts`). Dev's one box ran 12,979 sessions, and the
 * read weighed every verdict against all of them: catalog-api's release list spent 2 ms a verdict
 * there, 9 to 10 s in all with Postgres compiling each such read before running it. It also matched a
 * run of ANOTHER project whose group named the same key: catalog-fe ISS-5's judge read as its builder
 * because adminhub-api's run over its own ISS-5 was live on the box (47 verdicts on dev, 2026-10-26).
 *
 * @direct-test-of packages/core/src/issues/built-by.ts
 * @direct-test-of packages/core/src/db/client.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { verdictByBuilderSql } from '../../src/issues/built-by.js';
import {
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestRunSession,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';

const BUILT = new Date('2026-10-26T09:00:00Z');
const JUDGED = '2026-10-26T09:30:00Z';
const LANDED = 'd2dd9863e397c1b6b185bafdc06f9c7a88ee5589';

let ownerId: string;
let box: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  box = await createTestDevice(ownerId);
});

/** A run session on the box, live from BUILT, in `projectId`, declared over ISS-5 at `opened`. */
async function runOver(projectId: string, opened: string): Promise<void> {
  const runId = await createTestRunSession(projectId, box, BUILT, null);
  await db.execute(sql`
    UPDATE pipeline_runs SET metadata = ${JSON.stringify({
      type: 'run_session',
      runGroup: ['ISS-5'],
      runIssueStatuses: { 'ISS-5': opened },
    })}::jsonb WHERE id = ${runId}`);
}

/** A pass on ISS-5 c1 of `projectId` from the box at JUDGED, naming no session; its builder reading. */
async function boxPassIsBuilders(projectId: string): Promise<boolean> {
  const issue = await createTestIssue(projectId, ownerId, 5, {
    status: 'awaiting_release',
    createdAt: BUILT,
    mergedAt: BUILT,
  });
  const [c] = await rows<{ id: string }>(sql`
    INSERT INTO issue_criteria (issue_id, n, statement, position)
    VALUES (${issue.id}, 1, 'eslint loads its config', 0) RETURNING id`);
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, identity_kind, commit_sha,
                                    author_agency, author_device_id, evidence, created_at)
    VALUES (${c?.id}, ${issue.id}, 'pass', 'commit', ${LANDED}, 'agent', ${box},
            ARRAY['iss5.txt'], ${JUDGED})`);
  const [read] = await rows<{ builder: boolean }>(sql`
    SELECT ${verdictByBuilderSql({
      issueId: sql`v.issue_id`,
      authorUser: sql`v.author_user_id`,
      authorDevice: sql`v.author_device_id`,
      at: sql`v.created_at`,
      runSession: sql`v.run_session_id`,
    })} AS builder FROM criterion_verdicts v WHERE v.issue_id = ${issue.id}`);
  return read?.builder === true;
}

describe("a box's verdict is weighed against its own issue's sessions", () => {
  it('reads a judge as the builder where a run building this issue was live on the box', async () => {
    const projectId = (await createTestProject(ownerId)).id;
    await runOver(projectId, 'in_progress');
    expect(await boxPassIsBuilders(projectId)).toBe(true);
  });

  it("never reads another project's run over the same key as this issue's builder", async () => {
    const other = (await createTestProject(ownerId)).id;
    const projectId = (await createTestProject(ownerId)).id;
    await runOver(other, 'in_progress');
    expect(await boxPassIsBuilders(projectId)).toBe(false);
  });

  it('weighs it against no session at all where the box ran nothing over the issue', async () => {
    const projectId = (await createTestProject(ownerId)).id;
    for (let i = 0; i < 3; i += 1) await createTestRunSession(projectId, box, BUILT, null);
    expect(await boxPassIsBuilders(projectId)).toBe(false);
  });
});

describe("core's statements run without JIT compilation", () => {
  it('opens every pooled connection with jit off', async () => {
    const [row] = await rows<{ jit: string }>(sql`SHOW jit`);
    expect(row?.jit).toBe('off');
  });
});
