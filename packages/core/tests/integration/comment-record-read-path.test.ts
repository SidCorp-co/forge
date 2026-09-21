/**
 * ISS-1089 — the record and the lens, as `GET /api/issues/:id/comments` ships them.
 *
 * Against real Postgres because the whole claim is about a read path that joins
 * three tables to answer one question: which lens the people who can READ this
 * project carry. A mocked handle can be told what to return and proves nothing
 * about the predicate; the `organization_members`/`project_members`/`users`
 * rows are the test.
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

type RecordView = {
  kind: string | null;
  contract: number | null;
  fields: Array<{ key: string; value: string; over: number }>;
  lead: string | null;
  absent: string[];
  at: number;
  to: number;
  lens: 'product' | 'technical';
};
type Node = { id: string; body: string; record: RecordView | null };
type Page = { items: Node[] };

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];

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

  const [issuesMod, jwtMod, errMod] = await Promise.all([
    import('../../src/issues/routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
  ]);
  signUserToken = jwtMod.signUserToken;
  app = new Hono();
  app.route('/api/issues', issuesMod.issueRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

const FENCE = '```';
const LONG = 'x'.repeat(457);
const BODY = [
  '## Confirmation',
  '',
  `${FENCE}forge-record`,
  'where: the comment read path',
  `why: ${LONG}`,
  FENCE,
  '',
  '`forge-record: confirmation · contract 1`',
  '',
  'And a sentence below.',
].join('\n');

async function seed() {
  const owner = await createTestUser(harness.db, { email: 'owner@test.local' });
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`);
  const project = await createTestProject(harness.db, owner.id);
  await createTestProjectMember(harness.db, {
    userId: owner.id,
    projectId: project.id,
    role: 'admin',
  });
  const orgRows = await harness.db.execute<{ org_id: string }>(
    sql`SELECT org_id FROM projects WHERE id = ${project.id}`,
  );
  const orgId = (orgRows[0] as { org_id: string }).org_id;
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id)
    VALUES (${project.id}, 'record-target', ${owner.id})
    RETURNING id
  `);
  const issueId = (rows[0] as { id: string }).id;
  await harness.db.execute(sql`
    INSERT INTO comments (issue_id, author_id, body) VALUES (${issueId}, ${owner.id}, ${BODY})
  `);
  await harness.db.execute(sql`
    INSERT INTO comments (issue_id, author_id, body, created_at)
    VALUES (${issueId}, ${owner.id}, 'No record in this one.', now() - interval '1 minute')
  `);
  return { owner, project, orgId, issueId, jwt: await signUserToken(owner.id) };
}

const lensOf = async (lenses: string[], userId: string, orgId: string) =>
  harness.db.execute(
    sql`UPDATE organization_members SET lenses = ${sql.raw(`ARRAY[${lenses.map((l) => `'${l}'`).join(',')}]::text[]`)} WHERE org_id = ${orgId} AND user_id = ${userId}`,
  );

async function read(issueId: string, jwt: string): Promise<Page> {
  const res = await app.request(`/api/issues/${issueId}/comments`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}

const recorded = (page: Page) => page.items.find((n) => n.record !== null)?.record ?? null;

describe('the record the read path ships', () => {
  it('parses the fence into its fields, in the order written', async () => {
    const { issueId, jwt } = await seed();
    const record = recorded(await read(issueId, jwt));
    expect(record?.fields.map((f) => f.key)).toEqual(['where', 'why']);
    expect(record?.kind).toBe('confirmation');
  });

  it('carries the overage on the field that ran past the budget', async () => {
    const { issueId, jwt } = await seed();
    const record = recorded(await read(issueId, jwt));
    expect(record?.fields.map((f) => f.over)).toEqual([0, 57]);
  });

  it('reports `lead` and `beside` absent, and puts nothing in their place', async () => {
    const { issueId, jwt } = await seed();
    const record = recorded(await read(issueId, jwt));
    expect({ lead: record?.lead, absent: record?.absent }).toEqual({
      lead: null,
      absent: ['lead', 'beside'],
    });
  });

  it('says where the block sits, so the prose around it keeps its place', async () => {
    const { issueId, jwt } = await seed();
    const page = await read(issueId, jwt);
    const node = page.items.find((n) => n.record !== null) as Node;
    const record = node.record as RecordView;
    expect(node.body.slice(0, record.at)).toBe('## Confirmation\n\n');
    expect(node.body.slice(record.to)).toBe('\n\nAnd a sentence below.');
  });

  it('ships no record on the comment carrying no fence, and one on the comment that does', async () => {
    const { issueId, jwt } = await seed();
    const page = await read(issueId, jwt);
    const plain = page.items.find((n) => n.body === 'No record in this one.');
    const fenced = page.items.find((n) => n.body === BODY);
    expect({ plain: plain?.record, fencedKind: fenced?.record?.kind }).toEqual({
      plain: null,
      fencedKind: 'confirmation',
    });
  });
});

describe('the lens the read path resolves', () => {
  it('reads as product where the project’s only member carries no lens', async () => {
    const { issueId, jwt } = await seed();
    expect(recorded(await read(issueId, jwt))?.lens).toBe('product');
  });

  it('reads as technical once a member of this project carries the lens', async () => {
    const { owner, orgId, issueId, jwt } = await seed();
    await lensOf(['technical'], owner.id, orgId);
    expect(recorded(await read(issueId, jwt))?.lens).toBe('technical');
  });

  it('reads as product where that member carries `product` explicitly', async () => {
    const { owner, orgId, issueId, jwt } = await seed();
    await lensOf(['product'], owner.id, orgId);
    expect(recorded(await read(issueId, jwt))?.lens).toBe('product');
  });

  it('ignores a technical org member who cannot read this project', async () => {
    const { orgId, issueId, jwt } = await seed();
    const outsider = await createTestUser(harness.db, { email: 'outsider@test.local' });
    await harness.db.execute(sql`
      INSERT INTO organization_members (org_id, user_id, role, lenses)
      VALUES (${orgId}, ${outsider.id}, 'member', ARRAY['technical']::text[])
    `);
    expect(recorded(await read(issueId, jwt))?.lens).toBe('product');
  });

  it('counts an org admin, who derives admin on every project of the org', async () => {
    const { orgId, issueId, jwt } = await seed();
    const orgAdmin = await createTestUser(harness.db, { email: 'org-admin@test.local' });
    await harness.db.execute(sql`
      INSERT INTO organization_members (org_id, user_id, role, lenses)
      VALUES (${orgId}, ${orgAdmin.id}, 'admin', ARRAY['technical']::text[])
    `);
    expect(recorded(await read(issueId, jwt))?.lens).toBe('technical');
  });

  it('ignores an agent user carrying the technical lens', async () => {
    const { project, orgId, issueId, jwt } = await seed();
    const agent = await createTestUser(harness.db, { email: 'agent@test.local' });
    await harness.db.execute(sql`UPDATE users SET kind = 'agent' WHERE id = ${agent.id}`);
    await harness.db.execute(sql`
      INSERT INTO organization_members (org_id, user_id, role, lenses)
      VALUES (${orgId}, ${agent.id}, 'admin', ARRAY['technical']::text[])
    `);
    await createTestProjectMember(harness.db, {
      userId: agent.id,
      projectId: project.id,
      role: 'admin',
    });
    expect(recorded(await read(issueId, jwt))?.lens).toBe('product');
  });
});
