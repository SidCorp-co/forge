/**
 * ISS-1104: ISS-1075 sat at `reopen` with its round-3 merge mark newer than its reopen, and the strand
 * pass read it "waiting for a run to build it again" with `merged: true` beside it. A reopen whose
 * merge is recorded since that reopen is a fix round that landed: the master's to move on to
 * `awaiting_release`, as an open or approved landed row is (issue-delivery `rule-wedge`). A mark from
 * before the reopen is still the round sent back. Against real Postgres, through the pass itself.
 *
 * @direct-test-of packages/core/src/pipeline/idle-issues.ts
 * @direct-test-of packages/core/src/pipeline/wedge-landed.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';

let reconcileIdleIssues: typeof import('../../src/pipeline/idle-issues.js').reconcileIdleIssues;
let projectId: string;
let ownerId: string;
let seq = 0;

const COMMIT = `${'b'.repeat(39)}2`;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ({ reconcileIdleIssues } = await import('../../src/pipeline/idle-issues.js'));
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await bindTestRunner(projectId, await createTestDevice(ownerId));
});

/** A `reopen` row untouched for a day, reopened `reopenedHoursAgo` and marked `mergedHoursAgo`. */
async function reopened(args: { reopenedHoursAgo: number; mergedHoursAgo: number }) {
  const id = randomUUID();
  seq += 1;
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, created_at, updated_at,
                        merged_at, merged_commit_sha)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, 'reopen', ${ownerId},
            now() - interval '3 days', now() - interval '1 day',
            now() - make_interval(hours => ${args.mergedHoursAgo}), ${COMMIT})
  `);
  await db.execute(sql`
    INSERT INTO kernel_transitions (id, entity, entity_id, from_status, to_status, actor_type, actor_agency, source, created_at)
    VALUES (${randomUUID()}, 'issue', ${id}, 'awaiting_release', 'reopen', 'user', 'human', 'test',
            now() - make_interval(hours => ${args.reopenedHoursAgo}))
  `);
  return id;
}

async function strandOf(id: string) {
  const [row] = await rows<{ strand: Record<string, unknown> | null }>(sql`
    SELECT session_context -> 'strand' AS strand FROM issues WHERE id = ${id}
  `);
  return row?.strand ?? null;
}

describe('the strand on a reopened issue that carries a merge', () => {
  it('reads a mark recorded since the reopen as the master’s to move on to awaiting_release', async () => {
    const id = await reopened({ reopenedHoursAgo: 40, mergedHoursAgo: 30 });

    await reconcileIdleIssues(new Date(), { projectId });

    const strand = await strandOf(id);
    expect(strand, JSON.stringify(strand)).toMatchObject({
      status: 'reopen',
      waitingFor: 'the master to move it on to awaiting_release',
      owes: 'agent',
      evidence: { merged: true, mergedSinceReopen: true },
    });
    expect(String(strand?.waitingFor)).not.toContain('a run to build it again');
  });

  it('reads a mark from before the reopen as the fix round still owed', async () => {
    const id = await reopened({ reopenedHoursAgo: 30, mergedHoursAgo: 40 });

    await reconcileIdleIssues(new Date(), { projectId });

    expect(await strandOf(id)).toMatchObject({
      status: 'reopen',
      waitingFor: 'a run to build it again',
      evidence: { merged: true, mergedSinceReopen: false },
    });
  });
});
