/**
 * ISS-1251 — an entry into `on_hold` is announced on the thread, as `waiting` and `needs_info` are.
 *
 * Real Postgres, every door that moves an issue into `on_hold`: REST `/transition`, REST
 * `PATCH /batch`, MCP `forge_issues`, and core's own writer (the run cancel that parks its issue).
 * The announcement is the one record of an entry that is ordered against the rest of the thread,
 * so what is held here is that it is there, that it is the same write as the status, and that a
 * door which sent no reason is refused by name instead of moving the issue silently.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { connectClientAsPat } from '../helpers/mcp-harness.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];
let mintPat: typeof import('../../src/auth/pat.js')['mintPat'];
let issueStatuses: typeof import('../../src/pipeline/state-machine.js')['issueStatuses'];
let transitionIssueStatus: typeof import('../../src/issues/apply-transition.js')['transitionIssueStatus'];
let cancelPipelineRun: typeof import('../../src/pipeline/runs-control.js')['cancelPipelineRun'];
let announcesAMove: typeof import('../../src/issues/transition-reason.js')['announcesAMove'];

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const [transitionMod, extrasMod, jwtMod, patMod, errMod, machine, apply, runs, reason] =
    await Promise.all([
      import('../../src/issues/transition.js'),
      import('../../src/issues/extras-routes.js'),
      import('../../src/auth/jwt.js'),
      import('../../src/auth/pat.js'),
      import('../../src/middleware/error.js'),
      import('../../src/pipeline/state-machine.js'),
      import('../../src/issues/apply-transition.js'),
      import('../../src/pipeline/runs-control.js'),
      import('../../src/issues/transition-reason.js'),
    ]);
  signUserToken = jwtMod.signUserToken;
  mintPat = patMod.mintPat;
  issueStatuses = machine.issueStatuses;
  transitionIssueStatus = apply.transitionIssueStatus;
  cancelPipelineRun = runs.cancelPipelineRun;
  announcesAMove = reason.announcesAMove;
  app = new Hono();
  app.route('/api/issues', extrasMod.issueExtrasRoutes);
  app.route('/api/issues', transitionMod.transitionRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

type World = { userId: string; projectId: string; token: string; pat: string };

async function seed(): Promise<World> {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  const { plaintext } = await mintPat({
    userId: user.id,
    name: 'a token holding the door',
    boundProjectId: project.id,
  });
  return {
    userId: user.id,
    projectId: project.id,
    token: await signUserToken(user.id),
    pat: plaintext,
  };
}

async function insertIssue(w: World, status: string): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id, status, merged_at)
    VALUES (${w.projectId}::uuid, 'the subject', ${w.userId}::uuid, ${status},
            ${status === 'closed' ? sql`now()` : null})
    RETURNING id
  `);
  return (rows[0] as { id: string }).id;
}

async function statusOf(id: string): Promise<string> {
  const rows = await harness.db.execute<{ status: string }>(
    sql`SELECT status FROM issues WHERE id = ${id}::uuid`,
  );
  return (rows[0] as { status: string }).status;
}

async function thread(id: string): Promise<Array<{ body: string; xmin: string }>> {
  const rows = await harness.db.execute<{ body: string; xmin: string }>(sql`
    SELECT body, xmin::text AS xmin FROM comments WHERE issue_id = ${id}::uuid ORDER BY created_at, id
  `);
  return rows as unknown as Array<{ body: string; xmin: string }>;
}

async function transitionRowXmin(id: string, to: string): Promise<string | undefined> {
  const rows = await harness.db.execute<{ xmin: string }>(sql`
    SELECT xmin::text AS xmin FROM kernel_transitions
     WHERE entity = 'issue' AND entity_id = ${id}::uuid AND to_status = ${to}
  `);
  return (rows[0] as { xmin: string } | undefined)?.xmin;
}

const REASON = 'the owner asked for this to wait until the migration window closes';

const rest = (id: string, token: string, body: Record<string, unknown>) =>
  app.request(`/api/issues/${id}/transition`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const batch = (ids: string[], token: string, data: Record<string, unknown>) =>
  app.request('/api/issues/batch', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ids, data }),
  });

async function mcp(pat: string, args: Record<string, unknown>) {
  const ctx = await connectClientAsPat(pat, null);
  try {
    const res = (await ctx.client.callTool({ name: 'forge_issues', arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    return { isError: res.isError === true, text: res.content[0]?.text ?? '' };
  } finally {
    await ctx.close();
  }
}

/**
 * Every status an ordinary writer may enter `on_hold` from: the gate admits any but `draft`, which
 * has its own case below, and `on_hold` itself, which is a same-status move. The transition map's
 * `on_hold` rows are the recommended path and leave out `closed` and `dropped`, which the gate admits.
 */
const sourcesOfOnHold = () =>
  issueStatuses.filter((from) => from !== 'on_hold' && from !== 'draft');

describe('REST POST /transition into on_hold', () => {
  it('has the closed and dropped sources the transition map leaves out among the ones it covers', () => {
    expect(sourcesOfOnHold().length).toBeGreaterThan(10);
    expect(sourcesOfOnHold()).toEqual(expect.arrayContaining(['closed', 'dropped', 'releasing']));
    expect(sourcesOfOnHold()).not.toContain('draft');
  });

  it('leaves a draft where it is for an ordinary writer, naming the refusal, and writes nothing', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'draft');

    const res = await rest(id, w.token, { toStatus: 'on_hold', reason: REASON });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(((await res.json()) as { code: string }).code).toBe('ILLEGAL_TRANSITION');
    expect(await statusOf(id)).toBe('draft');
    expect(await thread(id)).toHaveLength(0);
  });

  it('announces the entry from every status that can enter it, in the status write’s own transaction', async () => {
    const w = await seed();
    for (const from of sourcesOfOnHold()) {
      const id = await insertIssue(w, from);

      const res = await rest(id, w.token, { toStatus: 'on_hold', reason: REASON });

      expect(res.status, `from ${from}`).toBe(200);
      expect(await statusOf(id)).toBe('on_hold');
      const comments = await thread(id);
      expect(comments, `from ${from}`).toHaveLength(1);
      const [first, ...afterFirst] = (comments[0]?.body ?? '').split('\n');
      expect(first).toBe(`⏸ **On hold** — moved from \`${from}\``);
      expect(afterFirst.join('\n').trim()).toBe(REASON);
      expect(announcesAMove(comments[0]?.body ?? '')).toBe(true);
      expect(
        comments[0]?.xmin,
        `from ${from}: one transaction wrote the comment and the move`,
      ).toBe(await transitionRowXmin(id, 'on_hold'));
    }
  });

  it('names the status entered, so its first line is not the one a waiting announcement has', async () => {
    const w = await seed();
    const held = await insertIssue(w, 'in_progress');
    const waited = await insertIssue(w, 'in_progress');

    await rest(held, w.token, { toStatus: 'on_hold', reason: REASON });
    await rest(waited, w.token, {
      toStatus: 'waiting',
      reason: REASON,
      waitingKind: 'needs_decision',
    });

    const heldFirst = ((await thread(held))[0]?.body ?? '').split('\n')[0];
    const waitedFirst = ((await thread(waited))[0]?.body ?? '').split('\n')[0];
    expect(heldFirst).toContain('On hold');
    expect(waitedFirst).toContain('Waiting');
    expect(heldFirst).not.toBe(waitedFirst);
  });

  it('refuses a move with no reason by name, and moves nothing and writes nothing', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'in_progress');

    const res = await rest(id, w.token, { toStatus: 'on_hold' });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error?: string; message?: string };
    expect(body.code).toBe('TRANSITION_REASON_REQUIRED');
    expect(JSON.stringify(body)).toContain('on_hold');
    expect(await statusOf(id)).toBe('in_progress');
    expect(await thread(id)).toHaveLength(0);
  });

  it('refuses a blank reason, and moves nothing and writes nothing', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'in_progress');

    const res = await rest(id, w.token, { toStatus: 'on_hold', reason: '   ' });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      code: string;
      details?: { fieldErrors?: { reason?: string[] } };
    };
    expect(body.code).toBe('BAD_REQUEST');
    expect(body.details?.fieldErrors?.reason?.length).toBeGreaterThan(0);
    expect(await statusOf(id)).toBe('in_progress');
    expect(await thread(id)).toHaveLength(0);
  });

  it('writes nothing for a same-status move, which stays a NO_OP', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'on_hold');

    const res = await rest(id, w.token, { toStatus: 'on_hold', reason: REASON });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('NO_OP');
    expect(await thread(id)).toHaveLength(0);
  });

  it('writes nothing for a move out of on_hold, which this change leaves as it was', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'on_hold');

    const res = await rest(id, w.token, {
      toStatus: 'in_progress',
      reason: 'the window is closed',
    });

    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe('in_progress');
    expect(await thread(id)).toHaveLength(0);
  });
});

describe('a move out of on_hold', () => {
  it('keeps the destination’s own announcement when that status needs a reason', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'on_hold');

    const res = await rest(id, w.token, {
      toStatus: 'needs_info',
      reason: 'which tenant is this for?',
    });

    expect(res.status).toBe(200);
    const comments = await thread(id);
    expect(comments).toHaveLength(1);
    expect((comments[0]?.body ?? '').split('\n')[0]).toBe(
      '❓ **Needs info** — moved from `on_hold`',
    );
  });
});

describe('REST PATCH /batch into on_hold', () => {
  it('skips an issue by name when no reason can travel with the move', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'in_progress');

    const res = await batch([id], w.token, { status: 'on_hold' });

    const body = (await res.json()) as { skipped: Array<{ id: string; reason: string }> };
    expect(body.skipped).toEqual([{ id, reason: 'transition_reason_required' }]);
    expect(await statusOf(id)).toBe('in_progress');
    expect(await thread(id)).toHaveLength(0);
  });
});

describe('MCP forge_issues into on_hold', () => {
  it('refuses a transition with no reason, naming what is needed', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'in_progress');

    const answer = await mcp(w.pat, {
      action: 'transition',
      documentId: id,
      data: { status: 'on_hold' },
    });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('TRANSITION_REASON_REQUIRED');
    expect(await statusOf(id)).toBe('in_progress');
    expect(await thread(id)).toHaveLength(0);
  });

  it('refuses a blank reason by the tool’s own schema, naming the field', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'in_progress');

    const answer = await mcp(w.pat, {
      action: 'transition',
      documentId: id,
      data: { status: 'on_hold', reason: '   ' },
    });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('reason');
    expect(await statusOf(id)).toBe('in_progress');
    expect(await thread(id)).toHaveLength(0);
  });

  it('announces a transition that carries a reason, and one that carries a note', async () => {
    const w = await seed();
    const withReason = await insertIssue(w, 'in_progress');
    const withNote = await insertIssue(w, 'approved');

    const a = await mcp(w.pat, {
      action: 'transition',
      documentId: withReason,
      data: { status: 'on_hold', reason: REASON },
    });
    const b = await mcp(w.pat, {
      action: 'update',
      documentId: withNote,
      data: { status: 'on_hold', note: REASON },
    });

    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);
    expect(((await thread(withReason))[0]?.body ?? '').split('\n')[0]).toBe(
      '⏸ **On hold** — moved from `in_progress`',
    );
    expect(((await thread(withNote))[0]?.body ?? '').split('\n')[0]).toBe(
      '⏸ **On hold** — moved from `approved`',
    );
  });
});

describe('core’s own writers into on_hold', () => {
  const issueRow = async (id: string, w: World, status: string) => ({
    id,
    projectId: w.projectId,
    status: status as never,
    reopenCount: 0,
  });

  it('refuses a trusted writer that sends no reason, by name, and moves nothing', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'in_progress');

    await expect(
      transitionIssueStatus(
        await issueRow(id, w, 'in_progress'),
        'on_hold',
        { type: 'device', id: w.userId, ownerId: w.userId },
        { skip: true },
      ),
    ).rejects.toMatchObject({ code: 'TRANSITION_REASON_REQUIRED' });
    expect(await statusOf(id)).toBe('in_progress');
    expect(await thread(id)).toHaveLength(0);
  });

  it('announces a trusted writer’s entry from draft, which an ordinary writer cannot make', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'draft');

    await transitionIssueStatus(
      await issueRow(id, w, 'draft'),
      'on_hold',
      { type: 'device', id: w.userId, ownerId: w.userId },
      { skip: true, transitionReason: REASON },
    );

    expect(await statusOf(id)).toBe('on_hold');
    expect(((await thread(id))[0]?.body ?? '').split('\n')[0]).toBe(
      '⏸ **On hold** — moved from `draft`',
    );
  });

  it('announces a trusted writer’s entry when it sends its reason', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'testing');

    await transitionIssueStatus(
      await issueRow(id, w, 'testing'),
      'on_hold',
      { type: 'device', id: w.userId, ownerId: w.userId },
      { skip: true, transitionReason: REASON },
    );

    const comments = await thread(id);
    expect(comments).toHaveLength(1);
    expect((comments[0]?.body ?? '').split('\n')[0]).toBe('⏸ **On hold** — moved from `testing`');
  });

  it('announces the hold a run cancel puts its issue in, saying the run was cancelled', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'in_progress');
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, current_step, metadata, started_at)
      VALUES (${runId}, ${w.projectId}::uuid, ${id}::uuid, 'issue', 'running', 'code', '{}'::jsonb, now())
    `);

    const result = await cancelPipelineRun(runId, { actorUserId: w.userId, actorAgency: 'human' });

    expect(result.issueParked).toBe(true);
    expect(await statusOf(id)).toBe('on_hold');
    const comments = await thread(id);
    expect(comments).toHaveLength(1);
    const [first, ...afterFirst] = (comments[0]?.body ?? '').split('\n');
    expect(first).toBe('⏸ **On hold** — moved from `in_progress`');
    expect(afterFirst.join('\n')).toMatch(/cancel/i);
  });
});
