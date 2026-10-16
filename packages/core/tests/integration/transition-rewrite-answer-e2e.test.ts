/**
 * ISS-1365 — a transition a rule stored as another status says so in its answer.
 *
 * Two rules move an agent's target: the autonomous driver stores `waiting` as `needs_info`, and the
 * release gate stores `closed` as `awaiting_release`. Each case here asks one surface — REST
 * `/transition`, REST `PATCH /batch`, MCP `forge_issues` — and reads the stored row back, so
 * `rewritten.stored` is held against the database rather than against the code that wrote it.
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

  const [transitionMod, extrasMod, patMod, errMod] = await Promise.all([
    import('../../src/issues/transition.js'),
    import('../../src/issues/extras-routes.js'),
    import('../../src/auth/pat.js'),
    import('../../src/middleware/error.js'),
  ]);
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

type World = { userId: string; projectId: string; token: string };

/**
 * An agent's credential on an autonomous project whose release gate is live: the PAT's user is
 * `kind = 'agent'` (ISS-1137), the project's `pipelineConfig` is set, and a release chain with a
 * live deploy binding is what `resolveReleaseGate` reads.
 */
async function seed(): Promise<World> {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  await harness.db.execute(
    sql`UPDATE users SET email_verified_at = now(), kind = 'agent' WHERE id = ${user.id}::uuid`,
  );
  await harness.db.execute(sql`
    UPDATE projects
       SET release_chain = '[{"branch": "main"}]'::jsonb, base_branch = 'main',
           agent_config = '{"pipelineConfig": {}}'::jsonb
     WHERE id = ${project.id}::uuid
  `);
  const connectionId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, config, secrets_enc, active)
    VALUES (${connectionId}, 'user', ${user.id}::uuid, 'coolify', '{}'::jsonb, NULL, true)
  `);
  await harness.db.execute(sql`
    INSERT INTO integration_bindings
      (id, connection_id, project_id, provider, role, stages, config, active)
    VALUES (${randomUUID()}, ${connectionId}, ${project.id}::uuid, 'coolify', 'deploy',
            '{live}'::text[], '{}'::jsonb, true)
  `);
  const { plaintext } = await mintPat({
    userId: user.id,
    name: 'an agent holding a token',
    boundProjectId: project.id,
  });
  return { userId: user.id, projectId: project.id, token: plaintext };
}

async function insertIssue(w: World, status: string): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id, status)
    VALUES (${w.projectId}::uuid, 'the subject', ${w.userId}::uuid, ${status})
    RETURNING id
  `);
  return (rows[0] as { id: string }).id;
}

async function storedRow(id: string): Promise<{ status: string; waitingKind: string | null }> {
  const rows = await harness.db.execute<{ status: string; waiting_kind: string | null }>(
    sql`SELECT status, waiting_kind FROM issues WHERE id = ${id}::uuid`,
  );
  const row = rows[0] as { status: string; waiting_kind: string | null };
  return { status: row.status, waitingKind: row.waiting_kind };
}

const PARK_REASON = 'the staging database password is not on this box';

const rest = (id: string, token: string, body: Record<string, unknown>) =>
  app.request(`/api/issues/${id}/transition`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const batch = (ids: string[], token: string, status: string) =>
  app.request('/api/issues/batch', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ids, data: { status } }),
  });

async function mcp(token: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ctx = await connectClientAsPat(token, null);
  try {
    const res = (await ctx.client.callTool({ name: 'forge_issues', arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    const text = res.content[0]?.text ?? '';
    if (res.isError) throw new Error(`forge_issues refused: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    await ctx.close();
  }
}

type Rewritten = {
  requested: string;
  stored: string;
  rule: string;
  waitingKind: { sent: string | null; stored: string | null };
  detail: string;
};

describe('POST /api/issues/:id/transition — the answer says what a rule stored', () => {
  it("names the driver's rewrite of an agent `waiting` onto `needs_info`", async () => {
    const w = await seed();
    const id = await insertIssue(w, 'in_progress');

    const res = await rest(id, w.token, {
      toStatus: 'waiting',
      reason: PARK_REASON,
      waitingKind: 'needs_decision',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; rewritten: Rewritten | null };
    expect(body.rewritten).toMatchObject({
      requested: 'waiting',
      stored: 'needs_info',
      rule: 'autonomous_driver',
    });
    const row = await storedRow(id);
    expect(body.status).toBe(row.status);
    expect(body.rewritten?.stored).toBe(row.status);
  });

  it('names the kind sent beside the kind the row stores', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'in_progress');

    const res = await rest(id, w.token, {
      toStatus: 'waiting',
      reason: PARK_REASON,
      waitingKind: 'needs_decision',
    });

    const body = (await res.json()) as { rewritten: Rewritten | null };
    const row = await storedRow(id);
    expect(body.rewritten?.waitingKind).toEqual({
      sent: 'needs_decision',
      stored: row.waitingKind,
    });
  });

  it('carries a sentence naming both statuses and the rule', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'in_progress');

    const res = await rest(id, w.token, {
      toStatus: 'waiting',
      reason: PARK_REASON,
      waitingKind: 'needs_decision',
    });

    const detail = ((await res.json()) as { rewritten: Rewritten | null }).rewritten?.detail ?? '';
    expect(detail).toContain('Waiting (waiting)');
    expect(detail).toContain('Needs info (needs_info)');
    expect(detail).toContain('autonomous driver');
  });

  it("names the release gate's rewrite of an agent `closed` onto `awaiting_release`", async () => {
    const w = await seed();
    const id = await insertIssue(w, 'testing');

    const res = await rest(id, w.token, { toStatus: 'closed' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; rewritten: Rewritten | null };
    expect(body.rewritten).toMatchObject({
      requested: 'closed',
      stored: 'awaiting_release',
      rule: 'release_gate',
      waitingKind: { sent: null, stored: null },
    });
    const row = await storedRow(id);
    expect(body.status).toBe(row.status);
    expect(body.rewritten?.stored).toBe(row.status);
  });

  it('answers `rewritten: null` where no rule moved the target, keeping the fields it had', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'open');

    const res = await rest(id, w.token, { toStatus: 'confirmed' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.rewritten).toBeNull();
    expect(body).toMatchObject({ id, status: 'confirmed', reopenCount: 0 });
    expect(typeof body.transitionedAt).toBe('string');
  });
});

describe('the refusals stay as they were', () => {
  it('a NO_OP a rule caused keeps 409, NO_OP, both statuses and its details', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'needs_info');

    const res = await rest(id, w.token, {
      toStatus: 'waiting',
      reason: PARK_REASON,
      waitingKind: 'needs_decision',
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      message: string;
      details: Record<string, unknown>;
    };
    expect(body.code).toBe('NO_OP');
    expect(body.message).toContain('Waiting (waiting)');
    expect(body.message).toContain('Needs info (needs_info)');
    expect(body.details).toEqual({
      status: 'needs_info',
      requested: 'waiting',
      substituted: 'needs_info',
    });
  });

  it('a NO_OP at the status asked for keeps its plain message', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'confirmed');

    const res = await rest(id, w.token, { toStatus: 'confirmed' });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('NO_OP');
    expect(body.message).toBe('issue already in status Confirmed (confirmed)');
  });
});

describe('forge_issues — the MCP answer carries the same rewrite', () => {
  it('transition answers the object REST gives for an issue in the same starting state', async () => {
    const w = await seed();
    const viaRest = await insertIssue(w, 'in_progress');
    const viaMcp = await insertIssue(w, 'in_progress');
    const park = { reason: PARK_REASON, waitingKind: 'needs_decision' };

    const restBody = (await (
      await rest(viaRest, w.token, { toStatus: 'waiting', ...park })
    ).json()) as { rewritten: Rewritten };
    const mcpBody = await mcp(w.token, {
      action: 'transition',
      documentId: viaMcp,
      data: { status: 'waiting', ...park },
    });

    expect(restBody.rewritten).toMatchObject({ rule: 'autonomous_driver', stored: 'needs_info' });
    expect(mcpBody.rewritten).toEqual(restBody.rewritten);
    expect(mcpBody.status).toBe((await storedRow(viaMcp)).status);
  });

  it('transition answers `rewritten: null` where no rule moved the target', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'open');

    const body = await mcp(w.token, {
      action: 'transition',
      documentId: id,
      data: { status: 'confirmed' },
    });

    expect(body.rewritten).toBeNull();
  });

  it('update with a status a rule rewrote answers with the same object', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'testing');

    const body = await mcp(w.token, {
      action: 'update',
      documentId: id,
      data: { status: 'closed' },
    });

    expect(body.rewritten).toMatchObject({
      requested: 'closed',
      stored: 'awaiting_release',
      rule: 'release_gate',
    });
    expect((body.rewritten as Rewritten).stored).toBe((await storedRow(id)).status);
  });
});

describe('PATCH /api/issues/batch — an updated row says what a rule stored', () => {
  it('carries `rewritten` on a row the release gate held, and none on a row it did not', async () => {
    const w = await seed();
    const held = await insertIssue(w, 'testing');
    const plain = await insertIssue(w, 'open');

    const agentRes = await batch([held], w.token, 'closed');
    expect(agentRes.status).toBe(200);
    const agentBody = (await agentRes.json()) as {
      updated: Array<{ id: string; rewritten?: Rewritten }>;
    };
    const heldRow = agentBody.updated.find((u) => u.id === held);
    expect(heldRow?.rewritten).toMatchObject({
      requested: 'closed',
      stored: 'awaiting_release',
      rule: 'release_gate',
    });
    expect(heldRow?.rewritten?.stored).toBe((await storedRow(held)).status);

    const plainRes = await batch([plain], w.token, 'confirmed');
    const plainBody = (await plainRes.json()) as {
      updated: Array<{ id: string; rewritten?: Rewritten }>;
    };
    const entry = plainBody.updated.find((u) => u.id === plain);
    expect(entry).toBeDefined();
    expect(entry && 'rewritten' in entry).toBe(false);
    expect((await storedRow(plain)).status).toBe('confirmed');
  });
});

// Judge-23 at 2fa8b2e: `update` sent with the status the issue holds answered `updated` and moved
// nothing, where the transition door refuses the same move NO_OP (ISS-1229 r10).
describe('forge_issues update — a status the issue already holds is refused, not ignored', () => {
  async function refusal(token: string, args: Record<string, unknown>): Promise<string> {
    const err = await mcp(token, args).then(
      () => null,
      (e: Error) => e.message,
    );
    if (err === null) throw new Error('forge_issues answered where a refusal was owed');
    return err;
  }

  async function row(id: string) {
    const rows = await harness.db.execute<{ title: string; status: string; updated_at: string }>(
      sql`SELECT title, status, updated_at::text FROM issues WHERE id = ${id}::uuid`,
    );
    return rows[0] as { title: string; status: string; updated_at: string };
  }

  it('refuses the status alone NO_OP, naming it as the transition door does', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'confirmed');

    const said = await refusal(w.token, {
      action: 'update',
      documentId: id,
      data: { status: 'confirmed' },
    });

    expect(said).toContain('NO_OP: issue already in status Confirmed (confirmed)');
    expect(said).not.toContain('Nothing else');
    expect((await row(id)).status).toBe('confirmed');
  });

  it('writes none of the fields beside it, and says to send them without the status', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'confirmed');
    const before = await row(id);

    const said = await refusal(w.token, {
      action: 'update',
      documentId: id,
      data: { status: 'confirmed', title: 'a new title', plan: 'a plan' },
    });

    expect(said).toContain('NO_OP: issue already in status Confirmed (confirmed)');
    expect(said).toContain('send it again without `data.status` to write the rest');
    expect(await row(id)).toEqual(before);
  });

  it('writes no relation it carried', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'confirmed');
    const blocker = await insertIssue(w, 'open');

    await refusal(w.token, {
      action: 'update',
      documentId: id,
      data: { status: 'confirmed', relations: [{ kind: 'blocks', dependsOnId: blocker }] },
    });

    const edges = await harness.db.execute(
      sql`SELECT 1 FROM issue_dependencies WHERE from_issue_id = ${id}::uuid OR to_issue_id = ${id}::uuid`,
    );
    expect(edges.length).toBe(0);
  });

  /** An agent's credential on a project with no release step, so a close is judged as itself. */
  async function plainWorld(): Promise<World> {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'admin',
    });
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now(), kind = 'agent' WHERE id = ${user.id}::uuid`,
    );
    const { plaintext } = await mintPat({
      userId: user.id,
      name: 'an agent on a project with no release step',
      boundProjectId: project.id,
    });
    return { userId: user.id, projectId: project.id, token: plaintext };
  }

  async function whole(id: string) {
    const rows = await harness.db.execute(sql`
      SELECT title, plan, release_notes, status, updated_at::text AS updated_at,
             (SELECT count(*)::int FROM issue_dependencies d
               WHERE d.from_issue_id = ${id}::uuid OR d.to_issue_id = ${id}::uuid) AS edges
        FROM issues WHERE id = ${id}::uuid
    `);
    return rows[0];
  }

  const NOTES = { section: 'Fixed', userFacing: 'A thing works.' };

  it.each([
    ['an illegal move out of Draft', 'draft', 'confirmed', 'ILLEGAL_TRANSITION'],
    ['a move to Developed with no work behind it', 'in_progress', 'developed', 'NO_WORK_EVIDENCE'],
    ['a close with nothing shipped', 'testing', 'closed', 'CLOSE_REQUIRES_SHIPPED'],
  ])(
    'a refused status move (%s) writes none of the fields, notes or relations beside it',
    async (_what, from, to, code) => {
      const w = await plainWorld();
      const id = await insertIssue(w, from);
      const other = await insertIssue(w, 'open');
      const before = await whole(id);

      const said = await refusal(w.token, {
        action: 'update',
        documentId: id,
        data: {
          status: to,
          title: 'a new title',
          plan: 'a plan',
          releaseNotes: NOTES,
          relations: [{ kind: 'blocks', dependsOnId: other }],
        },
      });

      expect(said).toContain(`${code}: `);
      expect(said).toContain('Nothing else this update carried was written');
      expect(await whole(id)).toEqual(before);
    },
  );

  it('closes on release notes written by the same update', async () => {
    const w = await plainWorld();
    const id = await insertIssue(w, 'testing');
    await harness.db.execute(
      sql`UPDATE issues SET merged_at = now(), merged_commit_sha = ${'a'.repeat(40)} WHERE id = ${id}::uuid`,
    );

    const body = await mcp(w.token, {
      action: 'update',
      documentId: id,
      data: { status: 'closed', releaseNotes: NOTES },
    });

    expect(body.status).toBe('closed');
    expect((await whole(id))?.release_notes).toEqual(NOTES);
  });

  it('writes the fields of an update whose move is made', async () => {
    const w = await plainWorld();
    const id = await insertIssue(w, 'open');

    const body = await mcp(w.token, {
      action: 'update',
      documentId: id,
      data: { status: 'confirmed', title: 'a new title' },
    });

    expect(body.status).toBe('confirmed');
    expect((await whole(id))?.title).toBe('a new title');
  });

  it('still writes the fields of an update that sends no status', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'confirmed');

    const body = await mcp(w.token, {
      action: 'update',
      documentId: id,
      data: { title: 'a new title' },
    });

    expect(body.action).toBe('updated');
    expect((await row(id)).title).toBe('a new title');
  });
});
