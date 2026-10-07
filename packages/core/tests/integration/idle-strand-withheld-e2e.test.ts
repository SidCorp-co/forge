/**
 * The idle-issues finding on a takeable row the admissible list withholds names what withholds it,
 * never a missing dispatch: hop ISS-72..76 each read "a runner is admitted and no run was ever
 * opened for this issue: the dispatch did not happen", owes agent, while a live `blocks` edge from
 * an open ISS-71 held every one of them. The finding is written without touching `updated_at`.
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

/** An open issue last touched an hour ago: past the open status's fifteen-minute clock. */
async function staleOpen(): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  seq += 1;
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, created_at, updated_at)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, 'open', ${ownerId},
            now() - interval '2 hours', now() - interval '1 hour')
  `);
  return { id, key: `ISS-${seq}` };
}

async function strandOf(id: string) {
  const [row] = await rows<{ strand: Record<string, unknown> | null; updated_at: string }>(sql`
    SELECT session_context -> 'strand' AS strand, updated_at::text AS updated_at FROM issues WHERE id = ${id}
  `);
  return row;
}

describe('the finding on a withheld row', () => {
  it('names the blocker whose blocks edge holds it, owed by that blocker, not a missing dispatch', async () => {
    const blocker = await staleOpen();
    const held = await staleOpen();
    await db.execute(sql`
      INSERT INTO issue_dependencies (project_id, from_issue_id, to_issue_id, kind)
      VALUES (${projectId}, ${blocker.id}, ${held.id}, 'blocks')
    `);
    const before = (await strandOf(held.id))?.updated_at;

    await reconcileIdleIssues(new Date(), { projectId });

    const read = await strandOf(held.id);
    expect(read?.strand, JSON.stringify(read?.strand)).toMatchObject({
      owes: 'blocker',
      waitingFor: expect.stringContaining(blocker.key),
      reason: expect.stringContaining(blocker.key),
    });
    expect(String(read?.strand?.reason)).not.toContain('the dispatch did not happen');
    expect(read?.updated_at).toBe(before);

    // the blocker itself is held by nothing, and nothing was dispatched onto it: that is the strand
    expect((await strandOf(blocker.id))?.strand).toMatchObject({
      owes: 'agent',
      reason: expect.stringContaining('the dispatch did not happen'),
    });
  });

  it('names the unapproved design of the workflow a row builds', async () => {
    const build = await staleOpen();
    const workflowId = randomUUID();
    await db.execute(sql`
      INSERT INTO project_workflows (id, project_id, flow, kind, revision, document, written_by_user)
      VALUES (${workflowId}, ${projectId}, 'intake', 'flow', 1, '{}'::jsonb, ${ownerId})
    `);
    await db.execute(sql`
      INSERT INTO workflow_builds (issue_id, workflow_id, project_id, linked_by_user)
      VALUES (${build.id}, ${workflowId}, ${projectId}, ${ownerId})
    `);

    await reconcileIdleIssues(new Date(), { projectId });

    expect((await strandOf(build.id))?.strand).toMatchObject({
      owes: 'blocker',
      reason: expect.stringContaining('design is not approved'),
    });
  });

  it('reads a settled blocker as holding nothing', async () => {
    const blocker = await staleOpen();
    const freed = await staleOpen();
    await db.execute(sql`
      INSERT INTO issue_dependencies (project_id, from_issue_id, to_issue_id, kind, valid_until)
      VALUES (${projectId}, ${blocker.id}, ${freed.id}, 'blocks', now() - interval '1 minute')
    `);

    await reconcileIdleIssues(new Date(), { projectId });

    expect((await strandOf(freed.id))?.strand).toMatchObject({
      owes: 'agent',
      reason: expect.stringContaining('the dispatch did not happen'),
    });
  });
});
