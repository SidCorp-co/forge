// cm:why against a real Postgres and not a mocked drizzle: every claim here is about what the
// DATABASE returns for a projection and about how ILIKE matches, and a mock of ILIKE agrees with
// itself whatever it is told. The JS `issueSearchMatchedFields` this replaces was unit-tested that
// way and could not have caught a disagreement with the predicate it sits beside (ISS-1016).

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
let omitted: readonly string[];

type ListBody = { items: Record<string, unknown>[]; total: number };

const PRESENT = [
  'id',
  'projectId',
  'issSeq',
  'displayId',
  'title',
  'status',
  'waitingKind',
  'priority',
  'category',
  'complexity',
  'assigneeId',
  'createdById',
  'createdVia',
  'source',
  'externalId',
  'detectorKey',
  'reportedBy',
  'reopenCount',
  'mergedAt',
  'mergedCommitSha',
  'releaseBatchRunId',
  'metadata',
  'createdAt',
  'updatedAt',
] as const;

async function seedIssue(
  seq: number,
  fields: {
    title: string;
    description?: string;
    plan?: string;
    acceptanceCriteria?: string;
  },
): Promise<string> {
  const rows = (await harness.db.execute(sql`
    INSERT INTO issues (project_id, created_by_id, iss_seq, title, description, plan,
                        acceptance_criteria, session_context, release_notes, metadata)
    VALUES (${projectId}::uuid, ${userId}::uuid, ${seq}, ${fields.title},
            ${fields.description ?? null}, ${fields.plan ?? null},
            ${fields.acceptanceCriteria ?? null},
            '{"branch":"iss-1016"}'::jsonb, '{"summary":"a note"}'::jsonb,
            '{"branchConfig":{"branch":"iss-1016-x"}}'::jsonb)
    RETURNING id`)) as unknown as { id: string }[];
  const id = rows[0]?.id;
  if (!id) throw new Error(`issue ${seq} was not inserted`);
  return id;
}

async function get(path: string): Promise<ListBody> {
  const res = await app.request(path, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as ListBody;
}

describe('the REST issue lists answer with a projection (ISS-1016)', () => {
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

    // cm:why dynamic, after DATABASE_URL is set: `db/client.ts` validates the environment at import
    // time, so a static import of anything reaching it fails the WHOLE file before a case runs.
    ({ REST_ISSUE_LIST_OMITTED: omitted } = await import('../../src/issues/list-projection.js'));
    const { issueProjectRoutes } = await import('../../src/issues/routes.js');
    const { searchRoutes } = await import('../../src/issues/search.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    const { signUserToken } = await import('../../src/auth/jwt.js');
    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/projects', issueProjectRoutes);
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

    await seedIssue(1, {
      title: 'Kernel audit',
      description: 'A body that names the runs-cascade.ts module.',
      plan: 'Prove FR-05~2 on every flip.',
      acceptanceCriteria: '1. FR-05~2 holds. 2. 100%_done is written literally.',
    });
    await seedIssue(2, {
      title: 'Something else entirely',
      description: 'No clause anywhere.',
      plan: 'A plan about applyTransition.',
      acceptanceCriteria: 'A criterion about snake_case names.',
    });
    // cm:why the identifier-only row: `LITELLM API` is a literal substring of nothing here, and
    // `forge_identifier_words` splits both the query and `LITELLM_API_URL` to `litellm api`, so the
    // `@@` arm is the only arm that can return it — which is what makes `matchedFields: []` a real
    // answer rather than a default.
    await seedIssue(3, {
      title: 'The LITELLM_API_URL fact',
      description: 'A body with no clause.',
      plan: 'A plan with no clause.',
      acceptanceCriteria: '1. The fact resolves.',
    });
  }, 120_000);

  afterAll(async () => {
    await harness.cleanup();
  });

  describe('GET /api/projects/:id/issues', () => {
    it('carries none of the body columns, the tsvector, or the parsed body nodes', async () => {
      const body = await get(`/api/projects/${projectId}/issues`);
      expect(body.items.length).toBeGreaterThan(0);
      for (const row of body.items) {
        for (const name of [...omitted, 'descriptionNodes']) {
          expect(Object.keys(row)).not.toContain(name);
        }
      }
    });

    it('still carries every scalar the projection promises', async () => {
      const [row] = (await get(`/api/projects/${projectId}/issues`)).items;
      expect(Object.keys(row ?? {})).toEqual(expect.arrayContaining([...PRESENT]));
    });
  });

  describe('GET /api/projects/:id/issues/search', () => {
    it('carries none of the body columns or the tsvector', async () => {
      const body = await get(`/api/projects/${projectId}/issues/search`);
      expect(body.items.length).toBeGreaterThan(0);
      for (const row of body.items) {
        for (const name of omitted) expect(Object.keys(row)).not.toContain(name);
      }
    });

    it('still carries every scalar the projection promises', async () => {
      const [row] = (await get(`/api/projects/${projectId}/issues/search`)).items;
      expect(Object.keys(row ?? {})).toEqual(expect.arrayContaining([...PRESENT]));
    });

    it('keeps the metadata web-v2 reads off a list row', async () => {
      const [row] = (await get(`/api/projects/${projectId}/issues/search?q=Kernel`)).items;
      expect((row?.metadata as { branchConfig?: { branch?: string } })?.branchConfig?.branch).toBe(
        'iss-1016-x',
      );
    });
  });

  describe('matchedFields, computed by Postgres', () => {
    it('names every field carrying the term, in ISSUE_SEARCH_FIELDS order', async () => {
      const body = await get(
        `/api/projects/${projectId}/issues/search?q=${encodeURIComponent('FR-05~2')}`,
      );
      expect(body.items.map((r) => r.matchedFields)).toEqual([['plan', 'acceptanceCriteria']]);
    });

    it('matches case-insensitively, as the predicate does', async () => {
      const body = await get(`/api/projects/${projectId}/issues/search?q=kernel`);
      expect(body.items.map((r) => r.matchedFields)).toEqual([['title']]);
    });

    it('treats a wildcard in the term as a literal character', async () => {
      const literal = await get(
        `/api/projects/${projectId}/issues/search?q=${encodeURIComponent('100%_done')}`,
      );
      expect(literal.items.map((r) => r.matchedFields)).toEqual([['acceptanceCriteria']]);
      // cm:guard the same row, one character apart, is what separates escaped from not: the seeded
      // criteria hold `100%_done`, so an UNESCAPED `%100%done%` matches it — `%` standing in for
      // `%_` — and would answer `['acceptanceCriteria']` here. Escaped, no field matches; the row
      // still comes back because the identifier arm splits `100%done` to a word the row carries,
      // so the empty array and not an empty page is the tell.
      const wildcard = await get(
        `/api/projects/${projectId}/issues/search?q=${encodeURIComponent('100%done')}`,
      );
      expect(wildcard.items.map((r) => r.matchedFields)).toEqual([[]]);
    });

    it('names the field a literal substring matched, even when the identifier arm matched too', async () => {
      const body = await get(`/api/projects/${projectId}/issues/search?q=cascade`);
      expect(body.items.map((r) => r.matchedFields)).toEqual([['description']]);
    });

    it('is [] on a row the identifier arm matched and no field matched literally', async () => {
      const body = await get(
        `/api/projects/${projectId}/issues/search?q=${encodeURIComponent('LITELLM API')}`,
      );
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.matchedFields).toEqual([]);
    });

    it('is absent from every row when the query carried no q', async () => {
      const body = await get(`/api/projects/${projectId}/issues/search`);
      for (const row of body.items) expect(Object.keys(row)).not.toContain('matchedFields');
    });
  });
});
