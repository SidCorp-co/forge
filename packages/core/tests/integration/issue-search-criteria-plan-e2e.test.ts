import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let projectId: string;
let userId: string;
let app: Hono<{ Variables: RequestIdVars }>;
let token: string;
let listService: typeof import('../../src/issues/list-service.js');

const CLAUSE = 'FR-05~2';
const ids: Record<string, string> = {};

type SearchBody = {
  items: { id: string; title: string; matchedFields?: string[] }[];
  total: number;
  returned: number;
  hasMore: boolean;
};

async function seedIssue(
  seq: number,
  key: string,
  fields: { title: string; description?: string; plan?: string; acceptanceCriteria?: string },
): Promise<void> {
  const rows = (await harness.db.execute(sql`
    INSERT INTO issues (project_id, created_by_id, iss_seq, title, description, plan, acceptance_criteria)
    VALUES (${projectId}::uuid, ${userId}::uuid, ${seq}, ${fields.title},
            ${fields.description ?? null}, ${fields.plan ?? null}, ${fields.acceptanceCriteria ?? null})
    RETURNING id`)) as unknown as { id: string }[];
  const id = rows[0]?.id;
  if (!id) throw new Error(`issue ${key} was not inserted`);
  ids[key] = id;
}

async function search(query: string): Promise<SearchBody> {
  const res = await app.request(`/api/projects/${projectId}/issues/search?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SearchBody;
}

describe('issue search reaches acceptanceCriteria and plan (ISS-960)', () => {
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
    process.env.EMBEDDINGS_BASE_URL ??= 'https://stub.invalid';
    process.env.EMBEDDINGS_API_KEY ??= 'stub-key';

    listService = await import('../../src/issues/list-service.js');
    const { searchRoutes } = await import('../../src/issues/search.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    const { signUserToken } = await import('../../src/auth/jwt.js');
    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/projects', searchRoutes);
    app.onError(errorHandler);

    await truncateAll(harness.db);
    const user = await createTestUser(harness.db);
    userId = user.id;
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${userId}::uuid`,
    );
    const project = await createTestProject(harness.db, userId);
    projectId = project.id;
    await createTestProjectMember(harness.db, { userId, projectId, role: 'admin' });
    token = await signUserToken(userId);

    // cm:why the clause sits in exactly ONE field per issue — an issue citing it in both fields would pass "across criteria and plan" for a single-field implementation too, which is the assertion this file exists to make unfakeable (ISS-960)
    await seedIssue(1, 'criteriaOnly', {
      title: 'Runner claims a job it cannot hold',
      description: 'Body that names no clause at all.',
      acceptanceCriteria: `1. The claim is refused. ${CLAUSE}\n2. The pool row stays free.`,
    });
    await seedIssue(2, 'planOnly', {
      title: 'Pool exclusion misses a held job',
      description: 'Body that names no clause at all.',
      plan: `Rewrite the exclusion in packages/core/src/jobs/pool-query.ts. Proves ${CLAUSE}.`,
    });
    await seedIssue(3, 'titleAndPlan', {
      title: `Kernel ${CLAUSE} audit`,
      plan: `Widen the audit so ${CLAUSE} is checked on every flip.`,
    });
    await seedIssue(4, 'unrelated', {
      title: 'Something else entirely',
      description: 'No clause anywhere.',
      plan: 'A plan about applyKernelTransition and runs-cascade.ts.',
      acceptanceCriteria: 'A criterion about 100% of the rows and snake_case names.',
    });
  }, 120_000);

  afterAll(async () => {
    await harness.cleanup();
  });

  it('finds an issue whose clause is only in its acceptanceCriteria, and names the field', async () => {
    const body = await search(`q=${encodeURIComponent(CLAUSE)}&sort=createdAt:asc`);
    expect(body.items.map((i) => i.id)).toContain(ids.criteriaOnly);
    const row = body.items.find((i) => i.id === ids.criteriaOnly);
    expect(row?.matchedFields).toEqual(['acceptanceCriteria']);
  });

  it('finds an issue whose clause is only in its plan, and names the field', async () => {
    const body = await search(`q=${encodeURIComponent(CLAUSE)}&sort=createdAt:asc`);
    expect(body.items.map((i) => i.id)).toContain(ids.planOnly);
    expect(body.items.find((i) => i.id === ids.planOnly)?.matchedFields).toEqual(['plan']);
  });

  it('names every field a row matched, not just the first', async () => {
    const body = await search(`q=${encodeURIComponent(CLAUSE)}&sort=createdAt:asc`);
    expect(body.items.find((i) => i.id === ids.titleAndPlan)?.matchedFields).toEqual([
      'title',
      'plan',
    ]);
  });

  it('returns exactly the three citing issues and not the fourth', async () => {
    const body = await search(`q=${encodeURIComponent(CLAUSE)}`);
    expect(new Set(body.items.map((i) => i.id))).toEqual(
      new Set([ids.criteriaOnly, ids.planOnly, ids.titleAndPlan]),
    );
    expect(body.total).toBe(3);
  });

  it('omits matchedFields entirely when no q was sent', async () => {
    const body = await search('limit=50');
    expect(body.items).toHaveLength(4);
    for (const row of body.items) expect(row).not.toHaveProperty('matchedFields');
  });

  it('answers a clause nobody cites with an empty page, not a cap', async () => {
    const body = await search(`q=${encodeURIComponent('FR-99~9')}`);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.hasMore).toBe(false);
  });

  it('says it was bounded and pages the rest', async () => {
    const first = await search(`q=${encodeURIComponent(CLAUSE)}&limit=2&sort=createdAt:asc`);
    expect(first.returned).toBe(2);
    expect(first.total).toBe(3);
    expect(first.hasMore).toBe(true);
    const second = await search(
      `q=${encodeURIComponent(CLAUSE)}&limit=2&offset=2&sort=createdAt:asc`,
    );
    expect(second.hasMore).toBe(false);
    const seen = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(seen).size).toBe(3);
    expect(new Set(seen)).toEqual(new Set([ids.criteriaOnly, ids.planOnly, ids.titleAndPlan]));
  });

  it('treats % and _ in the term as literal characters', async () => {
    const wild = await search(`q=${encodeURIComponent('100%')}`);
    expect(wild.items.map((i) => i.id)).toEqual([ids.unrelated]);
    const underscore = await search(`q=${encodeURIComponent('snake_case')}`);
    expect(underscore.items.map((i) => i.id)).toEqual([ids.unrelated]);
    const bare = await search(`q=${encodeURIComponent('%')}`);
    expect(bare.items.map((i) => i.id)).toEqual([ids.unrelated]);
  });

  it('applies the identifier split to plan and acceptanceCriteria, as it does to title', async () => {
    const cascade = await search(`q=${encodeURIComponent('cascade')}`);
    expect(cascade.items.map((i) => i.id)).toEqual([ids.unrelated]);
    const transition = await search(`q=${encodeURIComponent('Transition')}`);
    expect(transition.items.map((i) => i.id)).toEqual([ids.unrelated]);
    const poolQuery = await search(`q=${encodeURIComponent('pool query')}`);
    expect(poolQuery.items.map((i) => i.id)).toEqual([ids.planOnly]);
  });

  it('the browse projection finds the same issues and names the field without reading the body', async () => {
    const rows = await listService.listIssueRows(projectId, { search: CLAUSE }, 50);
    expect(new Set(rows.map((r) => r.id))).toEqual(
      new Set([ids.criteriaOnly, ids.planOnly, ids.titleAndPlan]),
    );
    expect(rows.find((r) => r.id === ids.criteriaOnly)?.matchedFields).toEqual([
      'acceptanceCriteria',
    ]);
    expect(rows.find((r) => r.id === ids.planOnly)?.matchedFields).toEqual(['plan']);
    // cm:why ISS-562's light projection is what makes this browse cheap, so widening the predicate must not widen the payload
    for (const heavy of ['description', 'plan', 'acceptanceCriteria', 'sessionContext']) {
      expect(rows[0]).not.toHaveProperty(heavy);
    }
  });

  it('carries no matchedFields on a browse with no search', async () => {
    const rows = await listService.listIssueRows(projectId, undefined, 50);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row).not.toHaveProperty('matchedFields');
  });

  it('generates ident_search over all four searchable columns', async () => {
    const [def] = (await harness.db.execute(sql`
      SELECT pg_get_expr(adbin, adrelid) AS expr
      FROM pg_attrdef
      WHERE adrelid = 'issues'::regclass
        AND adnum = (SELECT attnum FROM pg_attribute WHERE attrelid = 'issues'::regclass AND attname = 'ident_search')`)) as unknown as {
      expr: string;
    }[];
    for (const col of ['title', 'description', 'plan', 'acceptance_criteria']) {
      expect(def?.expr).toContain(col);
    }
    const [idx] = (await harness.db.execute(sql`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'issues_ident_search_idx'`)) as unknown as {
      indexdef: string;
    }[];
    expect(idx?.indexdef).toContain('USING gin');
  });
});
