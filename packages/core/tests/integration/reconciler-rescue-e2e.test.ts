/**
 * dev.49 / dev.53 — the reconciler rescues an `open` issue only where a wake for it may have been
 * LOST: never after a decision post-dates its last change, never while a declared run names it or
 * work is in flight, and a rescue that reached a box is redelivered on a doubling delay, six in all
 * per change (`pipeline/rescue-wake-ledger.ts`). The box wake is the one seam replaced; the
 * selection and the ledger run over Postgres.
 */

import { randomUUID } from 'node:crypto';
import { RUN_ISSUES_METADATA_KEY, RUN_SESSION_KIND } from '@forge/contracts/agent-sessions';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { runReconcilerOnce } from '../../src/pipeline/reconciler.js';
import { RESCUE_DELIVERY_LIMIT } from '../../src/pipeline/rescue-wake-ledger.js';
import { createTestProject, createTestUser, rows, truncateAll } from '../helpers/factories.js';

const woken: string[] = [];
let boxes = 1;

vi.mock('../../src/pipeline/ports.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/pipeline/ports.js')>();
  return {
    ...real,
    wakeMastersForProject: async (args: { issueId: string | null }) => {
      if (args.issueId) woken.push(args.issueId);
      return { boxes, delivered: boxes };
    },
  };
});

let projectId: string;
let ownerId: string;
let seq = 0;
const realNow = Date.now.bind(Date);
let offsetMs = 0;

beforeEach(async () => {
  await truncateAll();
  woken.length = 0;
  boxes = 1;
  offsetMs = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offsetMs);
  ownerId = (await createTestUser()).id;
  projectId = (await createTestProject(ownerId)).id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** An `open` issue last changed `minutesAgo` minutes ago, by the database's clock. */
async function openIssue(minutesAgo = 10): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  seq += 1;
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, updated_at)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, 'open', ${ownerId},
            now() - make_interval(mins => ${minutesAgo}))
  `);
  return { id, key: `ISS-${seq}` };
}

const tick = async () => (await runReconcilerOnce()).rescued;
const wakesFor = (id: string) => woken.filter((w) => w === id).length;
const advance = (minutes: number) => {
  offsetMs += minutes * 60_000;
};

describe('a lost wake is rescued', () => {
  it('wakes the masters for an open issue nothing holds and nothing has decided', async () => {
    const { id } = await openIssue();
    expect(await tick()).toBe(1);
    expect(wakesFor(id)).toBe(1);
  });

  it('leaves an issue changed inside the interval alone', async () => {
    const { id } = await openIssue(0);
    await tick();
    expect(wakesFor(id)).toBe(0);
  });
});

describe('a held row is not re-woken (dev.49)', () => {
  it('skips an issue whose decision post-dates its last change', async () => {
    const { id } = await openIssue();
    await db.execute(sql`
      INSERT INTO comments (issue_id, author_id, body, intent)
      VALUES (${id}, ${ownerId}, 'held: waiting on the vendor', 'decision')
    `);
    await tick();
    expect(wakesFor(id)).toBe(0);
  });

  it('rescues again once the issue changes after that decision', async () => {
    const { id } = await openIssue(20);
    await db.execute(sql`
      INSERT INTO comments (issue_id, author_id, body, intent, created_at)
      VALUES (${id}, ${ownerId}, 'held', 'decision', now() - interval '25 minutes')
    `);
    await tick();
    expect(wakesFor(id)).toBe(1);
  });

  it('is not held back by a comment that is not a decision', async () => {
    const { id } = await openIssue();
    await db.execute(sql`
      INSERT INTO comments (issue_id, author_id, body, intent)
      VALUES (${id}, ${ownerId}, 'what does this mean?', 'question')
    `);
    await tick();
    expect(wakesFor(id)).toBe(1);
  });
});

describe('a rescue that reached a box backs off (dev.49)', () => {
  it('redelivers at 2, 4, 8, 16 and 32 minutes, six in all, then stops for this change', async () => {
    const { id } = await openIssue();
    await tick();
    expect(wakesFor(id)).toBe(1);

    await tick();
    expect(wakesFor(id)).toBe(1);

    for (const [wait, total] of [
      [2, 2],
      [4, 3],
      [8, 4],
      [16, 5],
      [32, 6],
    ] as const) {
      advance(wait - 0.5);
      await tick();
      expect(wakesFor(id), `before the ${wait}-minute delay`).toBe(total - 1);
      advance(0.5);
      await tick();
      expect(wakesFor(id), `after the ${wait}-minute delay`).toBe(total);
    }
    expect(RESCUE_DELIVERY_LIMIT).toBe(6);

    advance(24 * 60);
    await tick();
    expect(wakesFor(id)).toBe(6);
  });

  it('starts a fresh count when the issue changes', async () => {
    const { id } = await openIssue();
    await tick();
    await tick();
    expect(wakesFor(id)).toBe(1);

    await db.execute(
      sql`UPDATE issues SET updated_at = now() - interval '5 minutes' WHERE id = ${id}`,
    );
    await tick();

    expect(wakesFor(id)).toBe(2);
  });

  it('counts nothing while no box is reached, so the next tick tries again', async () => {
    const { id } = await openIssue();
    boxes = 0;
    expect(await tick()).toBe(0);
    expect(await tick()).toBe(0);
    expect(wakesFor(id)).toBe(2);

    boxes = 1;
    expect(await tick()).toBe(1);
    expect(await tick()).toBe(0);
  });
});

describe('an issue a box already holds lost no wake (dev.53)', () => {
  it('skips an issue a live run declares, and rescues it once that run ends', async () => {
    const { id, key } = await openIssue();
    const runId = randomUUID();
    const sessionId = randomUUID();
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, metadata)
      VALUES (${runId}, ${projectId}, 'interactive', 'running',
              ${JSON.stringify({ [RUN_ISSUES_METADATA_KEY]: [key] })}::jsonb)
    `);
    await db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, user_id, pipeline_run_id, kind, status)
      VALUES (${sessionId}, ${projectId}, ${ownerId}, ${runId}, ${RUN_SESSION_KIND}, 'running')
    `);

    await tick();
    expect(wakesFor(id)).toBe(0);

    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    await withKernelMarker(db, (tx) =>
      tx.execute(sql`UPDATE agent_sessions SET status = 'completed' WHERE id = ${sessionId}`),
    );
    await tick();
    expect(wakesFor(id)).toBe(1);
  });

  it('skips an issue with a job not yet terminal', async () => {
    const { id } = await openIssue();
    const [run] = await rows<{ id: string }>(sql`
      INSERT INTO pipeline_runs (project_id, kind, status) VALUES (${projectId}, 'system', 'running')
      RETURNING id
    `);
    await db.execute(sql`
      INSERT INTO jobs (project_id, issue_id, pipeline_run_id, created_by, type, status, payload, queued_at)
      VALUES (${projectId}, ${id}, ${run?.id}, ${ownerId}, 'code', 'queued', '{}'::jsonb, now())
    `);
    await tick();
    expect(wakesFor(id)).toBe(0);
  });

  it('rescues an issue whose declaring run is another project’s', async () => {
    const { id, key } = await openIssue();
    const otherProject = (await createTestProject(ownerId)).id;
    const runId = randomUUID();
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, metadata)
      VALUES (${runId}, ${otherProject}, 'interactive', 'running',
              ${JSON.stringify({ [RUN_ISSUES_METADATA_KEY]: [key] })}::jsonb)
    `);
    await db.execute(sql`
      INSERT INTO agent_sessions (project_id, user_id, pipeline_run_id, kind, status)
      VALUES (${otherProject}, ${ownerId}, ${runId}, ${RUN_SESSION_KIND}, 'running')
    `);

    await tick();

    expect(wakesFor(id)).toBe(1);
  });
});
