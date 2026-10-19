/**
 * ISS-1251 round 4 — a blank reason reaches the one gate, at every door, and a batch carries a reason.
 *
 * Round 3 shipped with the REST body and the `forge_issues` schema each refusing a whitespace-only
 * reason first, so a blank into `on_hold` was answered "Too small: expected string to have >=1
 * characters" and named neither the status nor the shape that is valid. The gate's own refusal
 * does both, and it is the same for every status that needs a reason. Real Postgres.
 */

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

  const [transitionMod, extrasMod, jwtMod, patMod, errMod] = await Promise.all([
    import('../../src/issues/transition.js'),
    import('../../src/issues/extras-routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/auth/pat.js'),
    import('../../src/middleware/error.js'),
  ]);
  signUserToken = jwtMod.signUserToken;
  mintPat = patMod.mintPat;
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

async function bodiesOf(id: string): Promise<string[]> {
  const rows = await harness.db.execute<{ body: string }>(
    sql`SELECT body FROM comments WHERE issue_id = ${id}::uuid ORDER BY created_at, id`,
  );
  return rows.map((r) => r.body);
}

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

const BLANKS = ['', '   ', '\n\t '];

/** A target that needs an authored reason, the status it is entered from, and what its move also sends. */
const OWING = [
  { to: 'on_hold', from: 'in_progress', extra: {} },
  { to: 'needs_info', from: 'open', extra: {} },
  { to: 'waiting', from: 'in_progress', extra: { waitingKind: 'needs_decision' } },
  { to: 'reopen', from: 'developed', extra: {} },
] as const;

describe('REST /transition — a blank reason meets the gate, whatever it is sent for', () => {
  for (const { to, from, extra } of OWING) {
    it(`refuses a blank reason into ${to} as TRANSITION_REASON_REQUIRED naming it`, async () => {
      const w = await seed();
      for (const blank of BLANKS) {
        const id = await insertIssue(w, from);

        const res = await rest(id, w.token, { toStatus: to, reason: blank, ...extra });

        expect(res.status, `reason ${JSON.stringify(blank)}`).toBe(422);
        const body = (await res.json()) as { code: string };
        expect(body.code).toBe('TRANSITION_REASON_REQUIRED');
        expect(JSON.stringify(body)).toContain(to);
        expect(JSON.stringify(body)).toContain('reason');
        expect(await statusOf(id)).toBe(from);
        expect(await bodiesOf(id)).toHaveLength(0);
      }
    });
  }

  it('still lets the move from in_progress to reopen through, which owes no reason', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'in_progress');

    const res = await rest(id, w.token, { toStatus: 'reopen', reason: '   ' });

    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe('reopen');
    expect(await bodiesOf(id)).toHaveLength(0);
  });

  it('reads a blank reason on a move that owes none as no reason', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'open');

    const res = await rest(id, w.token, { toStatus: 'confirmed', reason: '   ' });

    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe('confirmed');
    expect(await bodiesOf(id)).toHaveLength(0);
  });
});

describe('forge_issues — a blank reason or note meets the gate too', () => {
  for (const { to, from, extra } of OWING) {
    it(`refuses a blank reason into ${to} as TRANSITION_REASON_REQUIRED naming it`, async () => {
      const w = await seed();
      const id = await insertIssue(w, from);

      const answer = await mcp(w.pat, {
        action: 'transition',
        documentId: id,
        data: { status: to, reason: '   ', ...extra },
      });

      expect(answer.isError).toBe(true);
      expect(answer.text).toContain('TRANSITION_REASON_REQUIRED');
      expect(answer.text).toContain(to);
      expect(await statusOf(id)).toBe(from);
    });
  }

  it('takes the note when the reason is blank, as it takes it when the reason is absent', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'in_progress');

    const answer = await mcp(w.pat, {
      action: 'update',
      documentId: id,
      data: { status: 'on_hold', reason: '   ', note: 'paused for the window' },
    });

    expect(answer.isError).toBe(false);
    expect(await statusOf(id)).toBe('on_hold');
    expect((await bodiesOf(id))[0]).toContain('paused for the window');
  });

  it('refuses a blank note into on_hold by the same name', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'in_progress');

    const answer = await mcp(w.pat, {
      action: 'transition',
      documentId: id,
      data: { status: 'on_hold', note: '  ' },
    });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('TRANSITION_REASON_REQUIRED');
  });
});

describe('PATCH /batch — one reason goes with every issue', () => {
  it('holds each issue it can, announcing each with the one reason', async () => {
    const w = await seed();
    const a = await insertIssue(w, 'in_progress');
    const b = await insertIssue(w, 'approved');

    const res = await batch([a, b], w.token, { status: 'on_hold', reason: 'the window is closed' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: Array<{ id: string }>; skipped: unknown[] };
    expect(body.updated.map((u) => u.id).sort()).toEqual([a, b].sort());
    expect(body.skipped).toEqual([]);
    for (const [id, from] of [
      [a, 'in_progress'],
      [b, 'approved'],
    ] as const) {
      expect(await statusOf(id)).toBe('on_hold');
      const [first, ...rest] = ((await bodiesOf(id))[0] ?? '').split('\n');
      expect(first).toBe(`⏸ **On hold** — moved from \`${from}\``);
      expect(rest.join('\n').trim()).toBe('the window is closed');
    }
  });

  it('skips every issue as transition_reason_required when the reason is absent or blank', async () => {
    const w = await seed();
    for (const data of [{ status: 'on_hold' }, { status: 'on_hold', reason: '   ' }]) {
      const id = await insertIssue(w, 'in_progress');

      const res = await batch([id], w.token, data);

      const body = (await res.json()) as { skipped: Array<{ id: string; reason: string }> };
      expect(body.skipped).toEqual([
        {
          id,
          reason: 'transition_reason_required',
          code: 'TRANSITION_REASON_REQUIRED',
          message: expect.any(String),
        },
      ]);
      expect(await statusOf(id)).toBe('in_progress');
      expect(await bodiesOf(id)).toHaveLength(0);
    }
  });

  it('refuses a reason sent without a status, by name', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'in_progress');

    const res = await batch([id], w.token, { priority: 'high', reason: 'the window is closed' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('reason');
    expect(await statusOf(id)).toBe('in_progress');
  });
});
