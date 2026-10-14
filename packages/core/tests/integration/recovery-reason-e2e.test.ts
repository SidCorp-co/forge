/**
 * The kernel's recovery moves are kept (forge-core-eb's ruling of 2026-10-14), and each says why on
 * the issue: a Sentry regression's reopen and a rescue-capped park post their reason as the move's
 * own comment (`transition-reason.ts:requiresAuthoredReason`), and the wedge reset posts its notice.
 * The hand-back when a run session ends wrote its reason only on the audit row where it went back to
 * `open` or `approved`, so the thread read an issue moved back with no word of why
 * (`transition-reason.ts:postRecoveryNotice`). Against real Postgres, through the kernel's own call.
 */

import { randomUUID } from 'node:crypto';
import {
  RUN_ISSUE_STATUSES_METADATA_KEY,
  RUN_ISSUES_METADATA_KEY,
  RUN_SESSION_KIND,
} from '@forge/contracts/agent-sessions';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { returnIssuesForRun } from '../../src/devices/index.js';
import { runReconcilerOnce } from '../../src/pipeline/reconciler.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';

// the reconciler's rescue pass wakes boxes; none is reached here
vi.mock('../../src/pipeline/ports.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/pipeline/ports.js')>();
  return { ...real, wakeMastersForProject: async () => ({ boxes: 0, delivered: 0 }) };
});

let projectId: string;
let ownerId: string;

// a move emits on the outbox, whose delivery job needs the queue the server boots
beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser()).id;
  projectId = (await createTestProject(ownerId)).id;
});

/** An `in_progress` issue an ended run took from `from`, and that run's id. */
async function ranAndEnded(from: string): Promise<{ id: string; key: string; runId: string }> {
  const issue = await createTestIssue(projectId, ownerId, 1, {
    status: 'in_progress',
    createdAt: new Date(Date.now() - 3_600_000),
  });
  const runId = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, metadata)
    VALUES (${runId}, ${projectId}, 'interactive', 'failed',
            ${JSON.stringify({
              [RUN_ISSUES_METADATA_KEY]: [issue.key],
              [RUN_ISSUE_STATUSES_METADATA_KEY]: { [issue.key]: from },
            })}::jsonb)
  `);
  await db.execute(sql`
    INSERT INTO agent_sessions (project_id, user_id, pipeline_run_id, kind, status)
    VALUES (${projectId}, ${ownerId}, ${runId}, ${RUN_SESSION_KIND}, 'failed')
  `);
  return { ...issue, runId };
}

const thread = (issueId: string) =>
  rows<{ body: string }>(
    sql`SELECT body FROM comments WHERE issue_id = ${issueId} ORDER BY created_at, id`,
  );

const WHY = 'its run session ended failed (the box went away)';

describe('a kernel hand-back says why on the issue', () => {
  it('posts why on an issue its ended run handed back to open', async () => {
    const { id, key, runId } = await ranAndEnded('open');

    const back = await returnIssuesForRun(runId, { reason: WHY });

    expect(back).toEqual([{ issueKey: key, from: 'in_progress', to: 'open' }]);
    const said = (await thread(id)).map((c) => c.body);
    expect(said, 'a hand-back with no word on the thread is a silent move').toHaveLength(1);
    expect(said[0]).toContain('Handed back — moved from `in_progress` to `open`');
    expect(said[0]).toContain(WHY);
  });

  it('says it once on a hand-back to reopen, whose move already posts its reason', async () => {
    const { id, runId } = await ranAndEnded('reopen');

    await returnIssuesForRun(runId, { reason: WHY });

    const said = (await thread(id)).map((c) => c.body);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('**Reopened**');
    expect(said[0]).toContain(WHY);
  });
});

describe('the reconciler says why it reset a wedge', () => {
  it('posts its notice on an in_progress issue nothing has held for the grace', async () => {
    const issue = await createTestIssue(projectId, ownerId, 1, {
      status: 'in_progress',
      createdAt: new Date(Date.now() - 3_600_000),
    });
    await db.execute(
      sql`UPDATE issues SET updated_at = now() - interval '30 minutes' WHERE id = ${issue.id}`,
    );

    expect((await runReconcilerOnce()).autonomousReset).toBe(1);

    const [row] = await rows<{ status: string }>(
      sql`SELECT status FROM issues WHERE id = ${issue.id}`,
    );
    expect(row?.status).toBe('open');
    const said = (await thread(issue.id)).map((c) => c.body);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('Moved by the reconciler: `in_progress` -> `open`');
  });
});
