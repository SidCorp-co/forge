/**
 * ISS-1158 — the `sourceCommentId` refusal belongs to `setIssueAttributes`,
 * the one writer, and not to one of the two doors that reach it.
 *
 * ISS-1113 put the guard in the HTTP route. The MCP tool calls the service
 * directly, so it wrote the off-issue pointer the guard exists to refuse, and
 * answered an id naming no comment with the insert statement and its bound
 * parameters. The same guard compared Postgres's lowercase `id` against the
 * caller's string, so an uppercase-hex uuid naming a real comment on the issue
 * was refused `SOURCE_COMMENT_NOT_FOUND`.
 *
 * Against real Postgres and through the real MCP transport, because every one
 * of those claims is about what a caller receives from a door.
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
let mintPat: typeof import('../../src/auth/pat.js').mintPat;
let setIssueAttributes: typeof import('../../src/issues/attributes/service.js').setIssueAttributes;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const [issuesMod, jwtMod, errMod, patMod, svcMod] = await Promise.all([
    import('../../src/issues/routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
    import('../../src/auth/pat.js'),
    import('../../src/issues/attributes/service.js'),
  ]);
  signUserToken = jwtMod.signUserToken;
  mintPat = patMod.mintPat;
  setIssueAttributes = svcMod.setIssueAttributes;
  app = new Hono();
  app.route('/api/issues', issuesMod.issueRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

/** Reference data migration 0245 seeds and `truncateAll` empties. */
async function seedDefs(): Promise<void> {
  const { ATTRIBUTE_REGISTRY } = await import('../../src/issues/attributes/registry.js');
  for (const def of ATTRIBUTE_REGISTRY) {
    await harness.db.execute(sql`
      INSERT INTO issue_attribute_defs (key, label, value_type, cardinality, written_by, surfaces, required)
      VALUES (${def.key}, ${def.label}, ${def.valueType}, ${def.cardinality}, ${def.writtenBy},
              ${JSON.stringify(def.surfaces)}::jsonb, ${def.required})
      ON CONFLICT (key) DO NOTHING
    `);
  }
}

beforeEach(async () => {
  await truncateAll(harness.db);
  await seedDefs();
});

/** An id no comment carries, spelled the way a caller would spell one. */
const ABSENT_COMMENT_ID = '00000000-0000-4000-8000-00000000dead';

async function seed() {
  const owner = await createTestUser(harness.db, { email: 'owner@test.local' });
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`);
  const project = await createTestProject(harness.db, owner.id);
  await createTestProjectMember(harness.db, {
    userId: owner.id,
    projectId: project.id,
    role: 'admin',
  });
  const mkIssue = async (title: string): Promise<string> => {
    const rows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO issues (project_id, title, created_by_id)
      VALUES (${project.id}, ${title}, ${owner.id}) RETURNING id
    `);
    return (rows[0] as { id: string }).id;
  };
  const mkComment = async (issueId: string, body: string): Promise<string> => {
    const rows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO comments (issue_id, author_id, body)
      VALUES (${issueId}, ${owner.id}, ${body}) RETURNING id
    `);
    return (rows[0] as { id: string }).id;
  };
  const issueId = await mkIssue('the subject');
  const otherIssueId = await mkIssue('the issue it supersedes');
  return {
    issueId,
    otherIssueId,
    commentId: await mkComment(issueId, 'This one supersedes the other; here is why.'),
    offIssueCommentId: await mkComment(otherIssueId, 'A sentence on the OTHER issue.'),
    jwt: await signUserToken(owner.id),
    pat: (await mintPat({ userId: owner.id, name: 'test-cli' })).plaintext,
  };
}

const write = (issueId: string, jwt: string, attributes: unknown[]) =>
  app.request(`/api/issues/${issueId}/attributes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ attributes }),
  });

/** What the MCP caller actually receives: the text of the one content block. */
async function callMcpSetAttributes(
  pat: string,
  issueId: string,
  attributes: unknown[],
): Promise<{ isError: boolean; text: string }> {
  const ctx = await connectClientAsPat(pat);
  try {
    const res = (await ctx.client.callTool({
      name: 'forge_issues',
      arguments: { action: 'setAttributes', documentId: issueId, attributes },
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    return { isError: res.isError === true, text: res.content[0]?.text ?? '' };
  } finally {
    await ctx.close();
  }
}

async function attributeRows(issueId: string): Promise<Array<Record<string, unknown>>> {
  return (await harness.db.execute(
    sql`SELECT key, value_ref, value_bool, source_comment_id FROM issue_attributes WHERE issue_id = ${issueId}`,
  )) as unknown as Array<Record<string, unknown>>;
}

/**
 * A caller is told what was wrong, never how the row would have been stored.
 * `Failed query: insert into "issue_attributes" …` plus `params: …` is what
 * the driver hands up when nothing refuses ahead of it.
 */
const SQL_SHAPES = [
  /insert\s+into/i,
  /\bselect\s/i,
  /\bdelete\s+from\b/i,
  /\bparams:/i,
  /\$\d+/,
  /failed query/i,
];

function expectNoSql(text: string): void {
  for (const shape of SQL_SHAPES) {
    expect(text, `refusal carried ${shape} — ${text}`).not.toMatch(shape);
  }
}

describe('the MCP door inherits the writer’s refusals (ISS-1158)', () => {
  it('refuses a sourceCommentId naming a comment on another issue, by name', async () => {
    const { issueId, otherIssueId, offIssueCommentId, pat } = await seed();
    const res = await callMcpSetAttributes(pat, issueId, [
      { key: 'supersedes', value: otherIssueId, sourceCommentId: offIssueCommentId },
    ]);
    expect(res.isError).toBe(true);
    expect(res.text).toContain('SOURCE_COMMENT_OFF_ISSUE');
  });

  it('writes no row for a batch refused on its sourceCommentId', async () => {
    const { issueId, otherIssueId, offIssueCommentId, pat } = await seed();
    await callMcpSetAttributes(pat, issueId, [
      { key: 'supersedes', value: otherIssueId, sourceCommentId: offIssueCommentId },
    ]);
    expect(await attributeRows(issueId)).toHaveLength(0);
  });

  it('leaves the value already there alone when the replacement is refused', async () => {
    const { issueId, offIssueCommentId, pat } = await seed();
    const kept = await callMcpSetAttributes(pat, issueId, [{ key: 'human_required', value: true }]);
    expect(kept.isError).toBe(false);

    await callMcpSetAttributes(pat, issueId, [
      { key: 'human_required', value: false, sourceCommentId: offIssueCommentId },
    ]);

    const rows = await attributeRows(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value_bool).toBe(true);
  });

  it('refuses a sourceCommentId naming no comment, by name', async () => {
    const { issueId, otherIssueId, pat } = await seed();
    const res = await callMcpSetAttributes(pat, issueId, [
      { key: 'supersedes', value: otherIssueId, sourceCommentId: ABSENT_COMMENT_ID },
    ]);
    expect(res.isError).toBe(true);
    expect(res.text).toContain('SOURCE_COMMENT_NOT_FOUND');
  });
});

describe('a refusal tells the caller what was wrong, not how it would have been stored', () => {
  it('carries no statement and no bound parameter at the MCP door', async () => {
    const { issueId, otherIssueId, offIssueCommentId, pat } = await seed();
    for (const sourceCommentId of [ABSENT_COMMENT_ID, offIssueCommentId]) {
      const res = await callMcpSetAttributes(pat, issueId, [
        { key: 'supersedes', value: otherIssueId, sourceCommentId },
      ]);
      expect(res.isError).toBe(true);
      expectNoSql(res.text);
    }
  });

  it('carries no statement and no bound parameter at the HTTP door', async () => {
    const { issueId, otherIssueId, offIssueCommentId, jwt } = await seed();
    for (const sourceCommentId of [ABSENT_COMMENT_ID, offIssueCommentId]) {
      const res = await write(issueId, jwt, [
        { key: 'supersedes', value: otherIssueId, sourceCommentId },
      ]);
      expect(res.status).toBe(400);
      expectNoSql(JSON.stringify(await res.json()));
    }
  });

  it('names the registry drift at the MCP door rather than handing up the insert', async () => {
    const { issueId, pat } = await seed();
    await harness.db.execute(sql`DELETE FROM issue_attribute_defs WHERE key = 'human_required'`);
    const res = await callMcpSetAttributes(pat, issueId, [{ key: 'human_required', value: true }]);
    expect(res.isError).toBe(true);
    expect(res.text).toContain('ATTRIBUTE_DEF_MISSING');
    expectNoSql(res.text);
  });
});

describe('a uuid is case-insensitive, and the comparison that reads it must be too', () => {
  it('accepts an uppercase-hex id naming a comment on this issue', async () => {
    const { issueId, otherIssueId, commentId, jwt } = await seed();
    // A generated uuid v4 nearly always carries a letter; assert it, so a run
    // of pure digits cannot make this pass without exercising the case at all.
    expect(commentId).toMatch(/[a-f]/);
    const res = await write(issueId, jwt, [
      { key: 'supersedes', value: otherIssueId, sourceCommentId: commentId.toUpperCase() },
    ]);
    expect(res.status).toBe(201);
  });

  it('lands the same row the lowercase spelling would have landed', async () => {
    const { issueId, otherIssueId, commentId, jwt } = await seed();
    await write(issueId, jwt, [
      { key: 'supersedes', value: otherIssueId, sourceCommentId: commentId.toUpperCase() },
    ]);
    const rows = await attributeRows(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source_comment_id).toBe(commentId);
  });
});

describe('the refusal is the writer’s, so a third caller inherits it', () => {
  it('refuses an off-issue pointer sent straight to setIssueAttributes', async () => {
    const { issueId, otherIssueId, offIssueCommentId } = await seed();
    await expect(
      setIssueAttributes([
        {
          issueId,
          key: 'supersedes',
          value: otherIssueId,
          sourceCommentId: offIssueCommentId,
        },
      ]),
    ).rejects.toMatchObject({ code: 'SOURCE_COMMENT_OFF_ISSUE' });
  });

  it('refuses an id naming no comment sent straight to setIssueAttributes', async () => {
    const { issueId, otherIssueId } = await seed();
    await expect(
      setIssueAttributes([
        {
          issueId,
          key: 'supersedes',
          value: otherIssueId,
          sourceCommentId: ABSENT_COMMENT_ID,
        },
      ]),
    ).rejects.toMatchObject({ code: 'SOURCE_COMMENT_NOT_FOUND' });
  });
});

describe('the HTTP door keeps the refusals ISS-1113 criterion 9 was judged on', () => {
  it('answers 400 SOURCE_COMMENT_NOT_FOUND in the wording it shipped with', async () => {
    const { issueId, otherIssueId, jwt } = await seed();
    const res = await write(issueId, jwt, [
      { key: 'supersedes', value: otherIssueId, sourceCommentId: ABSENT_COMMENT_ID },
    ]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('SOURCE_COMMENT_NOT_FOUND');
    expect(body.message).toBe(
      `sourceCommentId \`${ABSENT_COMMENT_ID}\` names no comment. It must be the id of a comment on this issue — the row exists to point back at the sentence that asserted it.`,
    );
  });

  it('answers 400 SOURCE_COMMENT_OFF_ISSUE in the wording it shipped with', async () => {
    const { issueId, otherIssueId, offIssueCommentId, jwt } = await seed();
    const res = await write(issueId, jwt, [
      { key: 'supersedes', value: otherIssueId, sourceCommentId: offIssueCommentId },
    ]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('SOURCE_COMMENT_OFF_ISSUE');
    expect(body.message).toBe(
      `sourceCommentId \`${offIssueCommentId}\` names a comment on a different issue (\`${offIssueCommentId}\` is on \`${otherIssueId}\`). The pointer must stay on the issue the attribute is written to, or no reader can follow it back.`,
    );
  });
});
