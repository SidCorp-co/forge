/**
 * ISS-564 (FB-135): the reconciler's wedge pass took every `in_progress` issue nothing held past the
 * grace and handed it back to the status its run claimed it from, so work whose merge was already
 * recorded became dispatchable again. Landed work stays at `in_progress` for an agent to move to
 * `awaiting_release` (REQ-45 BC-1, BC-7): no status moves by itself. Against real Postgres, through
 * the reconciler's own pass.
 *
 * Round 2 (judge K78): left landed work is told once per mark, whatever the lease's heartbeat reads,
 * and the telling wakes the project's master through the outbox and names the move it owes.
 *
 * ISS-1104 (FB-553): the pass handed held work away on a proxy signal: ISS-1063..1066 on
 * 2026-11-07, and ISS-1071..1073 at 07:54Z the same day, moved to `open` because their direct-mode
 * lease had lapsed while the builder was still landing them. It now moves no status at all: an unlanded wedge, a mark the issue was reopened after
 * and a design approval's stamp are each left where they stand, told once per stretch at
 * `in_progress`, and the project's master is woken and owes the decision (`wedge-owed.ts`).
 *
 * @direct-test-of packages/core/src/pipeline/reconciler.ts
 * @direct-test-of packages/core/src/pipeline/wedge-owed.ts
 * @direct-test-of packages/core/src/pipeline/wedge-lease.ts
 */

import { randomUUID } from 'node:crypto';
import { RUN_ISSUES_METADATA_KEY, RUN_SESSION_KIND } from '@forge/contracts/agent-sessions';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { transitionIssueStatus } from '../../src/issues/apply-transition.js';
import { runReconcilerOnce } from '../../src/pipeline/reconciler.js';
import { landedWorkOwed } from '../../src/pipeline/wedge-landed.js';
import { wedgedWorkOwed } from '../../src/pipeline/wedge-owed.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';

// the reconciler wakes boxes directly for an unheld wedge; none is reached here, each wake is counted
const woken = vi.hoisted(() => [] as Array<{ issueId: string | null; status: string }>);
vi.mock('../../src/pipeline/ports.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/pipeline/ports.js')>();
  return {
    ...real,
    wakeMastersForProject: async (args: { issueId: string | null; status: string }) => {
      woken.push({ issueId: args.issueId, status: args.status });
      return { boxes: 0, delivered: 0 };
    },
  };
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
  woken.length = 0;
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

const tick = async () => (await runReconcilerOnce()).wedgesTold;

/** The wakes written for an issue's landed work, oldest first. */
const wakes = async (id: string) =>
  rows<{ payload: { commit: string | null; mergedAt: string; projectId: string } }>(
    sql`SELECT payload FROM pipeline_outbox
         WHERE issue_id = ${id} AND type = 'issue.landedWorkLeft' ORDER BY seq`,
  );

const outboxTypes = async (id: string) =>
  (
    await rows<{ type: string }>(
      sql`SELECT type FROM pipeline_outbox WHERE issue_id = ${id} ORDER BY seq`,
    )
  ).map((r) => r.type);

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function leased(id: string, lease: Record<string, unknown>): Promise<void> {
  await db.execute(sql`
    INSERT INTO issue_work_state (issue_id, lease) VALUES (${id}, ${JSON.stringify(lease)}::jsonb)
    ON CONFLICT (issue_id) DO UPDATE SET lease = EXCLUDED.lease
  `);
}

describe('the wedge reset leaves landed work for its agent', () => {
  it('leaves an in_progress issue whose commit is marked, and says so once', async () => {
    const id = await wedged({ mergedAt: minutesAgo(20), commit: COMMIT });

    expect(await tick()).toBe(1);
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

describe('left landed work is told once per mark, and wakes its master', () => {
  it('posts one notice and one wake per mark under an abandoned lease, however long it stays silent', async () => {
    const id = await wedged({ mergedAt: minutesAgo(20), commit: COMMIT });
    // unexpired, but its heartbeat silent past what it tolerates: the silent seconds grow each pass
    await leased(id, {
      holder: 'box:run-gone',
      renewedAt: new Date().toISOString(),
      minutes: 60,
      heartbeat: { at: minutesAgo(30).toISOString(), everySeconds: 60 },
    });

    expect(await tick()).toBe(1);
    await pause(1_100);
    expect(await tick()).toBe(0);
    await pause(1_100);
    expect(await tick()).toBe(0);

    expect(await statusOf(id)).toBe('in_progress');
    const said = await thread(id);
    expect(said, 'one notice per mark, not one per pass').toHaveLength(1);
    expect(said[0]).toContain('heartbeat has been silent');
    const woke = await wakes(id);
    expect(woke, 'one wake per mark, not one per pass').toHaveLength(1);
    expect(woke[0]?.payload.commit).toBe(COMMIT);
    expect(woke[0]?.payload.projectId).toBe(projectId);
  });

  it('wakes its master through the outbox, and moves neither it nor an unmarked wedge', async () => {
    const landed = await wedged({ mergedAt: minutesAgo(20), commit: COMMIT });
    const unmarked = await wedged({});

    await tick();

    expect(await outboxTypes(landed)).toEqual(['issue.landedWorkLeft']);
    expect(await outboxTypes(unmarked), 'no transition: the status stays').not.toContain(
      'issue.transitioned',
    );
  });

  it('posts one notice and one wake per mark under a lapsed lease', async () => {
    const id = await wedged({ mergedAt: minutesAgo(20), commit: COMMIT });
    await leased(id, {
      holder: 'box:run-old',
      renewedAt: minutesAgo(120).toISOString(),
      minutes: 60,
    });

    expect(await tick()).toBe(1);
    expect(await tick()).toBe(0);

    expect(await statusOf(id)).toBe('in_progress');
    const said = await thread(id);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('lapsed at');
    expect(await wakes(id)).toHaveLength(1);
  });

  it('tells a new mark anew: the round landed again after a reopen', async () => {
    const first = minutesAgo(20);
    const id = await wedged({ mergedAt: first, commit: COMMIT });
    await tick();
    expect(await thread(id)).toHaveLength(1);

    // reopened after that mark, worked again, and landed again: a second mark at the same commit
    await db.execute(sql`
      INSERT INTO kernel_transitions (id, entity, entity_id, from_status, to_status, actor_type, actor_agency, source, created_at)
      VALUES (${randomUUID()}, 'issue', ${id}, 'awaiting_release', 'reopen', 'user', 'human', 'test', ${minutesAgo(15).toISOString()})
    `);
    const second = minutesAgo(5);
    await db.execute(sql`
      UPDATE issues SET merged_at = ${second.toISOString()}::timestamptz,
                        updated_at = now() - interval '30 minutes'
       WHERE id = ${id}
    `);

    expect(await tick()).toBe(1);
    expect(await tick()).toBe(0);

    expect(await statusOf(id)).toBe('in_progress');
    const said = await thread(id);
    expect(said, 'a new mark is told once').toHaveLength(2);
    expect(said[1]).toContain(second.toISOString());
    const woke = await wakes(id);
    expect(woke).toHaveLength(2);
    expect(woke.map((w) => w.payload.mergedAt)).toEqual([
      first.toISOString(),
      second.toISOString(),
    ]);
  });

  it('names it to its master as owed until it moves, and not while a lease holds it', async () => {
    const id = await wedged({ mergedAt: minutesAgo(20), commit: COMMIT });
    expect(await landedWorkOwed(projectId), 'not left yet: nothing told').toEqual([]);

    await tick();
    const owed = await landedWorkOwed(projectId);
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({ issueId: id, commit: COMMIT });
    expect(owed[0]?.key).toContain(String(seq));

    await leased(id, { holder: 'box:run-2', renewedAt: new Date().toISOString(), minutes: 60 });
    expect(await landedWorkOwed(projectId), 'a run holds it again').toEqual([]);
    await db.execute(sql`DELETE FROM issue_work_state WHERE issue_id = ${id}`);
    expect(await landedWorkOwed(projectId)).toHaveLength(1);

    const agent = { type: 'user' as const, id: ownerId, agency: 'human' as const };
    await transitionIssueStatus(
      { id, projectId, status: 'in_progress', reopenCount: 0 },
      'awaiting_release',
      agent,
      {},
    );
    expect(await landedWorkOwed(projectId), 'moved: owed no more').toEqual([]);
  });
});

/** The notices on an issue the pass left unheld, without a landing. */
const unheldNotices = async (id: string) =>
  (await thread(id)).filter((b) =>
    b.includes('Left at `in_progress` by the reconciler: nothing holds it'),
  );

describe('the wedge net moves no status: what did not land is left, told once, and its master woken', () => {
  it('leaves an in_progress issue with no mark where it stands, and says so once', async () => {
    const id = await wedged({});

    const told = await tick();
    expect(
      await statusOf(id),
      'the net handed held work away (ISS-1063..1066, ISS-1071..1073)',
    ).toBe('in_progress');
    expect(told).toBe(1);
    const said = await unheldNotices(id);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('no status was moved');
    expect(woken).toEqual([{ issueId: id, status: 'in_progress' }]);

    await db.execute(
      sql`UPDATE issues SET updated_at = now() - interval '30 minutes' WHERE id = ${id}`,
    );
    expect(await tick()).toBe(0);
    expect(await statusOf(id)).toBe('in_progress');
    expect(
      await unheldNotices(id),
      'one notice per stretch at in_progress, not one per pass',
    ).toHaveLength(1);
    expect(woken, 'one wake per stretch, not one per pass').toHaveLength(1);
  });

  it('names it to its master as owed until something holds or moves it', async () => {
    const id = await wedged({});
    expect(await wedgedWorkOwed(projectId), 'not told yet').toEqual([]);

    await tick();
    const owed = await wedgedWorkOwed(projectId);
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({ issueId: id });
    expect(owed[0]?.key).toContain(String(seq));

    await leased(id, { holder: 'box:run-2', renewedAt: new Date().toISOString(), minutes: 60 });
    expect(await wedgedWorkOwed(projectId), 'a run holds it again').toEqual([]);
    await db.execute(sql`DELETE FROM issue_work_state WHERE issue_id = ${id}`);
    expect(await wedgedWorkOwed(projectId)).toHaveLength(1);

    const person = { type: 'user' as const, id: ownerId, agency: 'human' as const };
    await transitionIssueStatus(
      { id, projectId, status: 'in_progress', reopenCount: 0 },
      'on_hold',
      person,
      { transitionReason: 'held until the release lands' },
    );
    expect(await wedgedWorkOwed(projectId), 'held: owed no more').toEqual([]);
  });

  it('tells a new stretch at in_progress anew: claimed again after it was told', async () => {
    const id = await wedged({});
    await tick();
    await db.execute(sql`
      INSERT INTO kernel_transitions (id, entity, entity_id, from_status, to_status, actor_type, actor_agency, source, created_at)
      VALUES (${randomUUID()}, 'issue', ${id}, 'open', 'in_progress', 'user', 'human', 'test', ${minutesAgo(15).toISOString()})
    `);
    await db.execute(
      sql`UPDATE issues SET updated_at = now() - interval '30 minutes' WHERE id = ${id}`,
    );

    expect(await tick()).toBe(1);
    expect(await unheldNotices(id)).toHaveLength(2);
    expect(woken).toHaveLength(2);
  });

  it('leaves an issue whose mark predates its last reopen, which is not this round', async () => {
    const id = await wedged({ mergedAt: minutesAgo(50), commit: COMMIT });
    await db.execute(sql`
      INSERT INTO kernel_transitions (id, entity, entity_id, from_status, to_status, actor_type, actor_agency, source, created_at)
      VALUES (${randomUUID()}, 'issue', ${id}, 'awaiting_release', 'reopen', 'user', 'human', 'test', ${minutesAgo(40).toISOString()})
    `);

    expect(await tick()).toBe(1);
    expect(await statusOf(id)).toBe('in_progress');
    expect(await unheldNotices(id)).toHaveLength(1);
    expect(await landedWorkOwed(projectId)).toEqual([]);
  });

  it('leaves an issue whose mark follows its last reopen, as landed work', async () => {
    const id = await wedged({ mergedAt: minutesAgo(20), commit: COMMIT });
    await db.execute(sql`
      INSERT INTO kernel_transitions (id, entity, entity_id, from_status, to_status, actor_type, actor_agency, source, created_at)
      VALUES (${randomUUID()}, 'issue', ${id}, 'awaiting_release', 'reopen', 'user', 'human', 'test', ${minutesAgo(40).toISOString()})
    `);

    expect(await tick()).toBe(1);
    expect(await statusOf(id)).toBe('in_progress');
    expect(await unheldNotices(id)).toHaveLength(0);
    expect(await wakes(id)).toHaveLength(1);
  });

  it("leaves an issue whose only mark is a design approval's stamp, which no release carries", async () => {
    const id = await wedged({ mergedAt: minutesAgo(20), designOnly: true });

    expect(await tick()).toBe(1);
    expect(await statusOf(id)).toBe('in_progress');
    expect(await unheldNotices(id)).toHaveLength(1);
  });

  it('parks no unheld wedge whose run sessions are spent: the master decides', async () => {
    const id = await wedged({});
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

    expect(await statusOf(id)).toBe('in_progress');
  });

  it('never touches an on_hold issue, however long nothing has written to it', async () => {
    seq += 1;
    const { id } = await createTestIssue(projectId, ownerId, seq, {
      status: 'on_hold',
      createdAt: new Date(Date.now() - 3_600_000),
    });
    await db.execute(
      sql`UPDATE issues SET updated_at = now() - interval '3 days' WHERE id = ${id}`,
    );

    expect(await tick()).toBe(0);
    expect(await statusOf(id)).toBe('on_hold');
    expect(await thread(id)).toHaveLength(0);
    expect(woken).toEqual([]);
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
    expect(await wakes(id), 'a held issue wakes nobody').toHaveLength(0);
    expect(await landedWorkOwed(projectId)).toEqual([]);
  });
});
