import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
let issues: typeof import('../../src/db/schema.js').issues;
let issueListPageQuery: typeof import('../../src/issues/list-projection.js').issueListPageQuery;
let buildIssueSearchCondition: typeof import('../../src/issues/search-predicate.js').buildIssueSearchCondition;
let matchedSearchFieldsSql: typeof import('../../src/issues/search-predicate.js').matchedSearchFieldsSql;
let buildIssueOrderBy: typeof import('../../src/issues/sort.js').buildIssueOrderBy;

const PROJECTS = 6;
const ROWS_PER_PROJECT = 1000;
const CASCADE_ROWS = 20;

/** Carries the plan out of the transaction the helper deliberately aborts. */
class PlanTaken extends Error {
  constructor(readonly plan: string) {
    super('plan taken');
  }
}

async function explain(
  query: { toSQL: () => { sql: string; params: unknown[] } },
  setup: string[] = [],
): Promise<string> {
  const { sql: text, params } = query.toSQL();
  const inlined = text.replace(/\$(\d+)/g, (_m, n) => literal(params[Number(n) - 1]));
  try {
    await harness.db.transaction(async (tx) => {
      for (const statement of setup) await tx.execute(sql.raw(statement));
      const rows = (await tx.execute(
        sql.raw(`EXPLAIN (FORMAT TEXT) ${inlined}`),
      )) as unknown as Record<string, string>[];
      throw new PlanTaken(rows.map((r) => Object.values(r)[0]).join('\n'));
    });
  } catch (err) {
    if (err instanceof PlanTaken) return err.plan;
    throw err;
  }
  throw new Error('EXPLAIN returned no plan');
}

/** drizzle renders binds as `$n`; EXPLAIN takes no parameters, so they are inlined. */
function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return `'${value.toISOString()}'::timestamptz`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

describe('the page queries and the search predicate are index-served (ISS-1016)', () => {
  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';
    process.env.EMBEDDINGS_BASE_URL ??= 'https://stub.invalid';
    process.env.EMBEDDINGS_API_KEY ??= 'stub-key';

    ({ issues } = await import('../../src/db/schema.js'));
    ({ issueListPageQuery } = await import('../../src/issues/list-projection.js'));
    ({ buildIssueSearchCondition, matchedSearchFieldsSql } = await import(
      '../../src/issues/search-predicate.js'
    ));
    ({ buildIssueOrderBy } = await import('../../src/issues/sort.js'));

    await truncateAll(harness.db);
    const user = await createTestUser(harness.db);
    userId = user.id;
    const projectIds: string[] = [];
    for (let i = 0; i < PROJECTS; i++) {
      const project = await createTestProject(harness.db, userId);
      projectIds.push(project.id);
    }
    projectId = projectIds[0] as string;
    await createTestProjectMember(harness.db, { userId, projectId, role: 'admin' });

    for (const [index, id] of projectIds.entries()) {
      await harness.db.execute(sql`
        INSERT INTO issues (project_id, created_by_id, iss_seq, title, description, plan, created_at, updated_at)
        SELECT ${id}::uuid, ${userId}::uuid, g,
               'Seeded issue ' || g,
               repeat('body text for row ' || g || ' ', 200),
               CASE WHEN ${index} = 0 AND g <= ${CASCADE_ROWS}
                    THEN 'Rewrite packages/core/src/pipeline/runs-cascade.ts'
                    ELSE 'A plan about row ' || g END,
               now() - (g || ' minutes')::interval,
               now() - (g || ' minutes')::interval
        FROM generate_series(1, ${ROWS_PER_PROJECT}) g`);
    }
    await harness.db.execute(sql`ANALYZE issues`);
  }, 180_000);

  afterAll(async () => {
    await harness.cleanup();
  });

  it('serves a createdAt page from issues_project_created_at_idx with no sort', async () => {
    const plan = await explain(
      issueListPageQuery({
        where: eq(issues.projectId, projectId),
        orderBy: buildIssueOrderBy('createdAt:desc'),
        limit: 50,
        offset: 0,
      }),
    );
    expect(plan).toContain('issues_project_created_at_idx');
    expect(plan).not.toContain('Sort');
  });

  it('serves an updatedAt page from issues_project_updated_at_idx with no sort', async () => {
    const plan = await explain(
      issueListPageQuery({
        where: eq(issues.projectId, projectId),
        orderBy: buildIssueOrderBy('updatedAt:desc'),
        limit: 50,
        offset: 0,
      }),
    );
    expect(plan).toContain('issues_project_updated_at_idx');
    expect(plan).not.toContain('Sort');
  });

  const INDEX_PREFERRED = ['SET LOCAL enable_seqscan = off'];

  const searchPage = () =>
    issueListPageQuery({
      where: buildIssueSearchCondition('cascade'),
      orderBy: buildIssueOrderBy('createdAt:desc'),
      limit: 50,
      offset: 0,
      matchedFields: matchedSearchFieldsSql('cascade'),
    });

  it('plans the search predicate as a BitmapOr that names the identifier index', async () => {
    const plan = await explain(searchPage(), INDEX_PREFERRED);
    expect(plan).toContain('BitmapOr');
    expect(plan).not.toContain('Seq Scan');
    expect(plan).toContain('issues_ident_search_idx');
    for (const trigram of [
      'issues_title_trgm_idx',
      'issues_description_trgm_idx',
      'issues_plan_trgm_idx',
      'issues_acceptance_criteria_trgm_idx',
    ]) {
      expect(plan).toContain(trigram);
    }
  });

  it('cannot reach the identifier index once the trigram indexes are gone', async () => {
    const plan = await explain(searchPage(), [
      ...INDEX_PREFERRED,
      'DROP INDEX issues_title_trgm_idx, issues_description_trgm_idx, issues_plan_trgm_idx, issues_acceptance_criteria_trgm_idx',
    ]);
    expect(plan).not.toContain('BitmapOr');
    expect(plan).not.toContain('issues_ident_search_idx');
    expect(plan).toContain('Seq Scan');
  });

  it('reads no issue text column into the process to name a match', async () => {
    const { sql: text } = issueListPageQuery({
      where: and(eq(issues.projectId, projectId), buildIssueSearchCondition('cascade')),
      orderBy: buildIssueOrderBy('createdAt:desc'),
      limit: 50,
      offset: 0,
      matchedFields: matchedSearchFieldsSql('cascade'),
    }).toSQL();
    const selected = text.slice(0, text.indexOf(' from '));
    for (const column of ['"description"', '"plan"', '"acceptance_criteria"', '"ident_search"']) {
      expect(selected).not.toContain(`${column},`);
    }
  });
});
