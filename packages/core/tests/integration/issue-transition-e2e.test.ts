/**
 * The issue status kernel, through `POST /api/issues/:id/transition` and the database's own guards:
 * a move is an edge of `ISSUE_MACHINE`, is audited in `kernel_transitions` in the same transaction,
 * and anything else — a non-edge, a raw status write, `closed` with nothing shipped — is refused
 * by name with nothing written.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { type ApiResponse, api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';

let projectId: string;
let ownerId: string;
let token: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  token = await userToken(ownerId);
});

let seq = 0;
async function issueAt(status: string): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId})
  `);
  return id;
}

const move = (id: string, body: Record<string, unknown>, as = token) =>
  api(as, 'POST', `/api/issues/${id}/transition`, body);

async function statusOf(id: string): Promise<string> {
  const [row] = await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`);
  return String(row?.status);
}

async function audit(id: string) {
  return rows<{
    from_status: string | null;
    to_status: string;
    reason: string | null;
    actor_id: string;
  }>(sql`
    SELECT from_status, to_status, reason, actor_id FROM kernel_transitions
     WHERE entity = 'issue' AND entity_id = ${id} ORDER BY created_at, id
  `);
}

function refusalCodes(res: ApiResponse): string[] {
  const listed = (res.body.error as { refusals?: Array<{ code: string }> } | undefined)?.refusals;
  return listed?.map((r) => r.code) ?? [String(res.body.code)];
}

describe('a move along an edge', () => {
  it('admits a draft, and audits the move with its actor in the same write', async () => {
    const id = await issueAt('draft');

    const res = await move(id, { toStatus: 'open' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id, status: 'open' });
    expect(await statusOf(id)).toBe('open');
    expect(await audit(id)).toEqual([
      expect.objectContaining({ from_status: 'draft', to_status: 'open', actor_id: ownerId }),
    ]);
  });

  it('parks an open issue on a question and returns it to the status it left, never another', async () => {
    const id = await issueAt('open');

    const parked = await move(id, {
      toStatus: 'needs_info',
      reason: 'which tenant is this for?',
      waitingKind: 'needs_answer',
    });
    expect(parked.status, JSON.stringify(parked.body)).toBe(200);

    const elsewhere = await move(id, { toStatus: 'approved' });
    expect(elsewhere.status).toBe(422);
    expect(await statusOf(id)).toBe('needs_info');

    const back = await move(id, { toStatus: 'open' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect((await audit(id)).map((a) => a.to_status)).toEqual(['needs_info', 'open']);
  });
});

describe('a move that is not an edge is refused by name, with nothing written', () => {
  it('refuses open → closed', async () => {
    const id = await issueAt('open');

    const res = await move(id, { toStatus: 'closed' });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/open.*closed/);
    expect(await statusOf(id)).toBe('open');
    expect(await audit(id)).toEqual([]);
  });

  it('refuses a move to the status the issue is already at', async () => {
    const id = await issueAt('open');
    const res = await move(id, { toStatus: 'open' });
    expect(res.status).toBe(422);
    expect(refusalCodes(res)).toContain('NO_OP');
  });

  it('refuses a park with no reason, the reason being what the park is for', async () => {
    const id = await issueAt('open');
    const res = await move(id, { toStatus: 'dropped' });
    expect(res.status).toBe(422);
    expect(await statusOf(id)).toBe('open');
  });

  it('refuses a waitingKind on a status that cannot hold one', async () => {
    const id = await issueAt('open');
    const res = await move(id, {
      toStatus: 'on_hold',
      reason: 'paused',
      waitingKind: 'needs_answer',
    });
    expect(res.status).toBe(422);
    expect(refusalCodes(res)).toContain('WAITING_KIND_NOT_APPLICABLE');
    expect(await statusOf(id)).toBe('open');
  });

  it('refuses a person who may not write the project', async () => {
    const viewer = await createTestUser({ verified: true });
    await addProjectMember(projectId, viewer.id, 'viewer');
    const id = await issueAt('draft');

    const res = await move(id, { toStatus: 'open' }, await userToken(viewer.id));

    expect(res.status).toBe(403);
    expect(await statusOf(id)).toBe('draft');
  });

  it('refuses a status field the door retired, naming the one it takes', async () => {
    const id = await issueAt('draft');
    const res = await move(id, { status: 'open' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toContain('toStatus');
  });
});

describe('two movers of one issue', () => {
  it('lets exactly one of two moves from the same status land, and audits only that one', async () => {
    const id = await issueAt('open');

    const [a, b] = await Promise.all([
      move(id, { toStatus: 'on_hold', reason: 'paused by a' }),
      move(id, { toStatus: 'dropped', reason: 'dropped by b' }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(refusalCodes(a.status === 409 ? a : b)).toEqual(['STALE_TRANSITION']);
    const landed = a.status === 200 ? 'on_hold' : 'dropped';
    expect(await statusOf(id)).toBe(landed);
    expect((await audit(id)).map((r) => r.to_status)).toEqual([landed]);
  });
});

/** The database's own words for a refused write, under the query wrapper drizzle throws. */
async function refusedBy(write: Promise<unknown>): Promise<string> {
  try {
    await write;
  } catch (err) {
    return String((err as { cause?: { message?: string } }).cause?.message ?? err);
  }
  throw new Error('the write was not refused');
}

describe('the database refuses what the kernel did not write', () => {
  it('refuses a raw status write, naming the kernel transition', async () => {
    const id = await issueAt('open');
    expect(
      await refusedBy(db.execute(sql`UPDATE issues SET status = 'in_progress' WHERE id = ${id}`)),
    ).toMatch(/^KERNEL_STATUS_WRITE_REFUSED: issue .* `open` -> `in_progress`/);
    expect(await statusOf(id)).toBe('open');
  });

  it('refuses closed with no merged_at even under the kernel flag', async () => {
    const id = await issueAt('awaiting_release');
    expect(
      await refusedBy(
        withKernelMarker(db, (tx) =>
          tx.execute(sql`UPDATE issues SET status = 'closed' WHERE id = ${id}`),
        ),
      ),
    ).toMatch(/cannot enter `closed` with no merged_at/);
    expect(await statusOf(id)).toBe('awaiting_release');
  });
});

describe('a side effect after the commit', () => {
  // the outbox CHECK as 0405 left it, admitting no `issue.pushed`: what failed the unblock toast
  // after hop ISS-29 and ISS-19 committed `awaiting_release` (2026-10-06), answered as a 500
  async function withoutIssuePushed<T>(act: () => Promise<T>): Promise<T> {
    const [held] = await rows<{ def: string }>(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'pipeline_outbox_type_chk'
    `);
    const def = String(held?.def);
    const narrowed = def.replace(/,?\s*'issue\.pushed'::text/, '');
    expect(narrowed).not.toBe(def);
    await db.execute(
      sql.raw('ALTER TABLE pipeline_outbox DROP CONSTRAINT pipeline_outbox_type_chk'),
    );
    await db.execute(
      sql.raw(`ALTER TABLE pipeline_outbox ADD CONSTRAINT pipeline_outbox_type_chk ${narrowed}`),
    );
    try {
      return await act();
    } finally {
      await db.execute(
        sql.raw('ALTER TABLE pipeline_outbox DROP CONSTRAINT pipeline_outbox_type_chk'),
      );
      await db.execute(
        sql.raw(`ALTER TABLE pipeline_outbox ADD CONSTRAINT pipeline_outbox_type_chk ${def}`),
      );
    }
  }

  it('answers the committed move and names the effect that failed, never a 500', async () => {
    const blocker = await issueAt('open');
    const dependent = await issueAt('open');
    await db.execute(sql`
      INSERT INTO issue_dependencies (project_id, from_issue_id, to_issue_id, kind)
      VALUES (${projectId}, ${blocker}, ${dependent}, 'blocks')
    `);

    const res = await withoutIssuePushed(() =>
      move(blocker, { toStatus: 'dropped', reason: 'not work: a duplicate' }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: blocker,
      status: 'dropped',
      afterCommitFailures: [{ effect: 'unblock_cascade' }],
    });
    expect(await statusOf(blocker)).toBe('dropped');
    expect((await audit(blocker)).map((r) => r.to_status)).toEqual(['dropped']);
  });

  it('carries no failure list when every side effect ran', async () => {
    const blocker = await issueAt('open');
    const dependent = await issueAt('open');
    await db.execute(sql`
      INSERT INTO issue_dependencies (project_id, from_issue_id, to_issue_id, kind)
      VALUES (${projectId}, ${blocker}, ${dependent}, 'blocks')
    `);

    const res = await move(blocker, { toStatus: 'dropped', reason: 'not work: a duplicate' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).not.toHaveProperty('afterCommitFailures');
  });
});
