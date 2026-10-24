/**
 * ISS-564 (FB-135): the reconciler's wedge reset took every `in_progress` issue nothing held past the
 * grace and handed it back to the status its run claimed it from, so work whose merge was already
 * recorded became dispatchable again. Landed work stays at `in_progress` for an agent to move to
 * `awaiting_release` (REQ-45 BC-1, BC-7): no status moves by itself. The reset still runs for an
 * issue with no mark, for a mark the issue was reopened after, and for a design approval's stamp,
 * which no release carries. Against real Postgres, through the reconciler's own pass.
 */

import { randomUUID } from 'node:crypto';
import { RUN_ISSUES_METADATA_KEY, RUN_SESSION_KIND } from '@forge/contracts/agent-sessions';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { transitionIssueStatus } from '../../src/issues/apply-transition.js';
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

const COMMIT = `${'a'.repeat(39)}1`;

let projectId: string;
let ownerId: string;
let seq = 0;

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

/** An `in_progress` issue nothing has written to for half an hour, its mark as given. */
async function wedged(mark: {
  mergedAt?: Date;
  commit?: string;
  designOnly?: boolean;
}): Promise<string> {
  seq += 1;
  const issue = await createTestIssue(projectId, ownerId, seq, {
    status: 'in_progress',
    createdAt: new Date(Date.now() - 3_600_000),
    ...(mark.mergedAt ? { mergedAt: mark.mergedAt } : {}),
  });
  if (mark.commit) {
    await db.execute(
      sql`UPDATE issues SET merged_commit_sha = ${mark.commit} WHERE id = ${issue.id}`,
    );
  }
  if (mark.designOnly) {
    const artifacts = [{ surface: 'design', ref: 'issue-delivery r24', change: 'changed' }];
    await db.execute(
      sql`UPDATE issues SET merged_artifacts = ${JSON.stringify(artifacts)}::jsonb WHERE id = ${issue.id}`,
    );
  }
  await db.execute(
    sql`UPDATE issues SET updated_at = now() - interval '30 minutes' WHERE id = ${issue.id}`,
  );
  return issue.id;
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

const statusOf = async (id: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`))[0]?.status;

const thread = async (id: string) =>
  (
    await rows<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${id} ORDER BY created_at, id`,
    )
  ).map((c) => c.body);

const tick = async () => (await runReconcilerOnce()).autonomousReset;

describe('the wedge reset leaves landed work for its agent', () => {
  it('leaves an in_progress issue whose commit is marked, and says so once', async () => {
    const id = await wedged({ mergedAt: minutesAgo(20), commit: COMMIT });

    expect(await tick()).toBe(0);
    expect(await statusOf(id), 'landed work handed back is dispatchable again').toBe('in_progress');
    const said = await thread(id);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('Left at `in_progress` by the reconciler');
    expect(said[0]).toContain(COMMIT);
    expect(said[0]).toContain('awaiting_release');

    await db.execute(
      sql`UPDATE issues SET updated_at = now() - interval '30 minutes' WHERE id = ${id}`,
    );
    expect(await tick()).toBe(0);
    expect(await statusOf(id)).toBe('in_progress');
    expect(await thread(id), 'one notice per mark, not one per pass').toHaveLength(1);
  });

  it('leaves it ready for release: the agent move to awaiting_release passes', async () => {
    const id = await wedged({ mergedAt: minutesAgo(20), commit: COMMIT });
    await tick();

    const person = { type: 'user' as const, id: ownerId, agency: 'human' as const };
    await transitionIssueStatus(
      { id, projectId, status: 'in_progress', reopenCount: 0 },
      'awaiting_release',
      person,
      {},
    );

    expect(await statusOf(id)).toBe('awaiting_release');
  });

  it('leaves a merged issue the rescue cap would park, rather than parking it', async () => {
    const id = await wedged({ mergedAt: minutesAgo(20), commit: COMMIT });
    // three ended run sessions naming the issue: the cap (`autonomous-rescue-cap.ts`) is spent
    for (let i = 0; i < 3; i++) {
      const runId = randomUUID();
      await db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, kind, status, metadata)
        VALUES (${runId}, ${projectId}, 'interactive', 'failed',
                ${JSON.stringify({ [RUN_ISSUES_METADATA_KEY]: [`ISS-${seq}`] })}::jsonb)
      `);
      await db.execute(sql`
        INSERT INTO agent_sessions (project_id, user_id, pipeline_run_id, kind, status)
        VALUES (${projectId}, ${ownerId}, ${runId}, ${RUN_SESSION_KIND}, 'failed')
      `);
    }

    await tick();

    expect(await statusOf(id), 'landed work parked for its master is not ready for release').toBe(
      'in_progress',
    );
  });
});

describe('the wedge reset still hands back what did not land', () => {
  it('resets an in_progress issue with no mark to open, as before', async () => {
    const id = await wedged({});

    expect(await tick()).toBe(1);
    expect(await statusOf(id)).toBe('open');
    expect((await thread(id))[0]).toContain('Moved by the reconciler: `in_progress` -> `open`');
  });

  it('resets an issue whose mark predates its last reopen: that is the last round', async () => {
    const id = await wedged({ mergedAt: minutesAgo(50), commit: COMMIT });
    await db.execute(sql`
      INSERT INTO kernel_transitions (id, entity, entity_id, from_status, to_status, actor_type, actor_agency, source, created_at)
      VALUES (${randomUUID()}, 'issue', ${id}, 'awaiting_release', 'reopen', 'user', 'human', 'test', ${minutesAgo(40).toISOString()})
    `);

    expect(await tick()).toBe(1);
    expect(await statusOf(id)).toBe('open');
  });

  it('leaves an issue whose mark follows its last reopen', async () => {
    const id = await wedged({ mergedAt: minutesAgo(20), commit: COMMIT });
    await db.execute(sql`
      INSERT INTO kernel_transitions (id, entity, entity_id, from_status, to_status, actor_type, actor_agency, source, created_at)
      VALUES (${randomUUID()}, 'issue', ${id}, 'awaiting_release', 'reopen', 'user', 'human', 'test', ${minutesAgo(40).toISOString()})
    `);

    expect(await tick()).toBe(0);
    expect(await statusOf(id)).toBe('in_progress');
  });

  it("resets an issue whose only mark is a design approval's stamp, which no release carries", async () => {
    const id = await wedged({ mergedAt: minutesAgo(20), designOnly: true });

    expect(await tick()).toBe(1);
    expect(await statusOf(id)).toBe('open');
  });

  it('never touches a merged issue a live lease holds, and posts nothing', async () => {
    const id = await wedged({ mergedAt: minutesAgo(20), commit: COMMIT });
    const lease = { holder: 'box:run-1', renewedAt: new Date().toISOString(), minutes: 60 };
    await db.execute(sql`
      INSERT INTO issue_work_state (issue_id, lease) VALUES (${id}, ${JSON.stringify(lease)}::jsonb)
    `);

    expect(await tick()).toBe(0);
    expect(await statusOf(id)).toBe('in_progress');
    expect(await thread(id)).toHaveLength(0);
  });
});
