/**
 * ISS-1421 r14, criterion 151 — a status move its input check refuses answers in a sentence, not
 * as "Invalid input" or "invalid arguments — …".
 *
 * Judge-61 sent `toStatus: "shipped"` through POST /transition and PATCH /batch and read "Invalid
 * input", and the same status through forge_issues and read a lower-case line listing every stored
 * value; a transition with no status read "data.status is required for transition". Each door is
 * driven here with that input and the issue read back unmoved. Real Postgres.
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  registerIntegrationsForTest,
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
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();

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

let projectId: string;
let ownerId: string;
let token: string;
let pat: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  ownerId = user.id;
  projectId = (await createTestProject(harness.db, user.id)).id;
  await createTestProjectMember(harness.db, { userId: user.id, projectId, role: 'admin' });
  token = await signUserToken(user.id);
  pat = (await mintPat({ userId: user.id, name: 'a door', boundProjectId: projectId })).plaintext;
});

async function plantIssue(): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id, status)
    VALUES (${projectId}, 'the subject', ${ownerId}, 'open')
    RETURNING id
  `);
  return (rows[0] as { id: string }).id;
}

async function statusOf(id: string): Promise<string> {
  const rows = await harness.db.execute<{ status: string }>(
    sql`SELECT status FROM issues WHERE id = ${id}`,
  );
  return (rows[0] as { status: string }).status;
}

async function send(method: string, path: string, body: unknown) {
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: res.status as number,
    body: (await res.json()) as {
      code?: string;
      message?: string;
      details?: { accepted?: Record<string, string[]>; fieldErrors?: Record<string, string[]> };
    },
  };
}

async function mcp(args: Record<string, unknown>) {
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

/** Every sentence opens with a capital and ends with a full stop. */
function wholeSentences(text: string): void {
  for (const s of text.split(/(?<=\.) (?=\S)/)) {
    expect(s, s).toMatch(/^[A-Z`]/);
    expect(s, s).toMatch(/\.$/);
  }
}

const STORED = /in_progress|awaiting_release|needs_info|on_hold/;

describe('a status Forge does not have, through REST (criterion 151)', () => {
  it('POST /transition answers 400 in a sentence, the statuses kept in details', async () => {
    const id = await plantIssue();
    const { status, body } = await send('POST', `/api/issues/${id}/transition`, {
      toStatus: 'shipped',
    });
    expect(status).toBe(400);
    expect(body.code).toBe('BAD_REQUEST');
    expect(body.message).toBe(
      'The field toStatus takes one of the values listed in details.accepted.',
    );
    wholeSentences(body.message ?? '');
    expect(body.message).not.toMatch(STORED);
    expect(body.details?.accepted?.toStatus).toContain('awaiting_release');
    expect(body.details?.fieldErrors?.toStatus).toBeDefined();
    expect(await statusOf(id)).toBe('open');
  });

  it('PATCH /batch answers 400 in a sentence naming data.status', async () => {
    const id = await plantIssue();
    const { status, body } = await send('PATCH', '/api/issues/batch', {
      ids: [id],
      data: { status: 'shipped' },
    });
    expect(status).toBe(400);
    expect(body.message).toBe(
      'The field data.status takes one of the values listed in details.accepted.',
    );
    expect(body.message).not.toMatch(STORED);
    expect(body.details?.accepted?.['data.status']).toContain('in_progress');
    expect(await statusOf(id)).toBe('open');
  });

  it('PATCH /batch with nothing to move says so in a sentence', async () => {
    const id = await plantIssue();
    const { status, body } = await send('PATCH', '/api/issues/batch', { ids: [id], data: {} });
    expect(status).toBe(400);
    expect(body.message).toBe('The field data was refused. No fields to update.');
  });
});

describe('a status move refused at forge_issues (criterion 151)', () => {
  it.each(['transition', 'update'])(
    '%s with a status Forge does not have opens with a capital and keeps the values off the sentence',
    async (action) => {
      const id = await plantIssue();
      const res = await mcp({ action, documentId: id, data: { status: 'shipped' } });
      expect(res.isError).toBe(true);
      const [sentence = '', ...rest] = res.text.replace(/^Error: /, '').split('\n');
      expect(sentence).toMatch(/The field `data\.status` takes one of the values listed below\.$/);
      wholeSentences(sentence);
      expect(sentence).not.toMatch(STORED);
      expect(rest.join('\n')).toMatch(/^`data\.status` takes: .*"awaiting_release"/);
      expect(await statusOf(id)).toBe('open');
    },
  );

  it('transition with no status names the field in a capitalised sentence', async () => {
    const id = await plantIssue();
    const res = await mcp({ action: 'transition', documentId: id, data: {} });
    expect(res.isError).toBe(true);
    expect(res.text).toBe('Error: Name the status to move the issue to as `data.status`.');
    expect(await statusOf(id)).toBe('open');
  });

  it('transition with no issue names documentId in a capitalised sentence', async () => {
    const res = await mcp({ action: 'transition', data: { status: 'in_progress' } });
    expect(res.isError).toBe(true);
    expect(res.text).toBe('Error: Name the issue to move as `documentId`.');
  });
});
