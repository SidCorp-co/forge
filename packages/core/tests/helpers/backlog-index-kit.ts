/**
 * What the ISS-1336 end-to-end suites share: a real database and server, the issue and edge
 * seeds, and the arithmetic of `forge next` written out by hand.
 *
 * The scores a suite compares against are computed HERE from the CLI's published table
 * (`plugin/src/rank/weights.mjs`), never by the code under test, so a score the maintainer
 * computes wrongly fails instead of agreeing with itself. State is exported as live bindings:
 * `startKit`, `resetKit` and `stopKit` are the suite's `beforeAll`, `beforeEach` and `afterAll`.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from './index.js';

const PRIORITY: Record<string, number> = { critical: 40, high: 30, medium: 20, low: 10, none: 0 };
const KIND: Record<string, number> = { bug: 8, enhancement: 4, review: 2, feature: 0 };
const COMPLEXITY: Record<string, number> = { xs: 8, s: 6, m: 4, l: 2, xl: 1, unset: 0 };

export { PRIORITY };

export interface Fixture {
  priority: string;
  category: string | null;
  complexity: string | null;
  reopen: number;
  days: number;
  chain: number;
}

/** What `forge next` scores one issue at, under the built-in table. */
export function cliTotal(f: Fixture): number {
  return (
    (PRIORITY[f.priority] ?? 0) +
    (KIND[f.category ?? 'feature'] ?? 0) +
    (COMPLEXITY[f.complexity ?? 'unset'] ?? 0) +
    f.days +
    (f.reopen ? 5 : 0) +
    f.chain * 3
  );
}

export let harness: TestDatabase;
export let server: TestServer;
export let userId: string;
export let projectId: string;
export let token: string;
export let maintainer: typeof import('../../src/issues/backlog/rank-maintainer.js');
export let alikeMaintainer: typeof import('../../src/issues/backlog/alike-maintainer.js');
export let configService: typeof import('../../src/pipeline/pipeline-config-service.js');
export let embeddingsMod: typeof import('../../src/embeddings/index.js');
export let searchMod: typeof import('../../src/memory/search.js');
let signUserToken: (id: string) => Promise<string>;

export async function startKit(): Promise<void> {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.EMBEDDINGS_BASE_URL ??= 'http://embeddings.invalid';
  process.env.EMBEDDINGS_API_KEY ??= 'test-key';
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  maintainer = await import('../../src/issues/backlog/rank-maintainer.js');
  alikeMaintainer = await import('../../src/issues/backlog/alike-maintainer.js');
  configService = await import('../../src/pipeline/pipeline-config-service.js');
  embeddingsMod = await import('../../src/embeddings/index.js');
  searchMod = await import('../../src/memory/search.js');
  server = await startTestServer();
}

export async function stopKit(): Promise<void> {
  if (server) await server.close();
  if (harness) await harness.cleanup();
}

export async function resetKit(): Promise<void> {
  await truncateAll(harness.db);
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  userId = user.id;
  const project = await createTestProject(harness.db, user.id);
  projectId = project.id;
  await createTestProjectMember(harness.db, { userId, projectId, role: 'admin' });
  token = await signUserToken(userId);
}

export interface SeedOpts {
  status?: string;
  priority?: string;
  category?: string | null;
  complexity?: string | null;
  reopen?: number;
  days?: number;
  title?: string;
}

export async function seedIssue(seq: number, o: SeedOpts = {}): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, description, status, priority, category,
                        complexity, reopen_count, created_by_id, created_at)
    VALUES (${id}, ${projectId}, ${seq}, ${o.title ?? `ranked subject ${seq}`}, ${`body of ${seq}`},
            ${o.status ?? 'open'}, ${o.priority ?? 'medium'}, ${o.category ?? null},
            ${o.complexity ?? null}, ${o.reopen ?? 0}, ${userId},
            now() - (${o.days ?? 0} || ' days')::interval)
  `);
  return id;
}

export async function edge(
  from: string,
  to: string,
  extra: { validUntil?: string; holds?: string } = {},
): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind, valid_until, holds_until)
    VALUES (${randomUUID()}, ${projectId}, ${from}, ${to}, 'blocks',
            ${extra.validUntil ?? null}::timestamptz, ${extra.holds ?? 'settled'})
  `);
}

export async function call(path: string, init: RequestInit = {}) {
  return fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

export interface Ranked {
  issueId: string;
  displayId: string;
  score: { total: number; parts: Array<{ name: string; said: string; points: number }> };
  chained: number;
  eligible: boolean;
  blockedBy: Array<{ displayId: string; status: string; holdsUntil: string }>;
  lease: { holder: string | null; live: boolean } | null;
}

export interface RankingBody {
  order: Ranked[];
  takeable: number;
  eligible: number;
  weights: { from: string; value: Record<string, unknown> };
  index: { state: string; pending: number; lapsed: number; oldestPendingAt: string | null };
  edges: string;
  excluded: Array<{ term: string }>;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export async function ranking(query = ''): Promise<{ status: number; body: RankingBody }> {
  const res = await call(`/api/projects/${projectId}/backlog/ranking${query}`);
  return { status: res.status, body: (await res.json()) as RankingBody };
}

export const rows = async <T = Record<string, unknown>>(
  query: ReturnType<typeof sql>,
): Promise<T[]> => (await harness.db.execute(query)) as unknown as T[];

export const pendingRows = async (...kinds: string[]) => {
  const wanted = kinds.length ? kinds : ['rank'];
  const [row] = await rows<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM backlog_index_dirty
     WHERE project_id = ${projectId} AND index_kind IN (${sql.join(
       wanted.map((k) => sql`${k}`),
       sql`, `,
     )})`);
  return Number(row?.n);
};

/** Brings the ranking index up to date, as the tick would. */
export async function catchUp(): Promise<void> {
  for (let i = 0; i < 10 && (await pendingRows()) > 0; i++) await maintainer.drainRank(projectId);
}

export const computedAt = async () =>
  Object.fromEntries(
    (
      await rows<{ id: string; at: string }>(
        sql`SELECT issue_id::text AS id, computed_at::text AS at FROM issue_rank_scores`,
      )
    ).map((r) => [r.id, r.at]),
  );

interface FixtureIssue extends Partial<Fixture>, SeedOpts {
  key: string;
  seq: number;
}

/** Nine issues, eight of them takeable, E holding F up and F holding G up. */
const BACKLOG: FixtureIssue[] = [
  { key: 'A', seq: 1, priority: 'high', category: 'bug', complexity: 'xs', days: 10 },
  {
    key: 'B',
    seq: 2,
    priority: 'critical',
    category: null,
    complexity: 'l',
    days: 2,
    status: 'confirmed',
  },
  {
    key: 'C',
    seq: 3,
    priority: 'medium',
    category: 'enhancement',
    complexity: null,
    days: 30,
    status: 'approved',
  },
  {
    key: 'D',
    seq: 4,
    priority: 'low',
    category: 'review',
    complexity: 'm',
    days: 0,
    reopen: 2,
    status: 'reopen',
  },
  { key: 'E', seq: 5, priority: 'medium', category: 'feature', complexity: 's', days: 5, chain: 2 },
  { key: 'F', seq: 6, priority: 'medium', category: 'feature', complexity: 's', days: 5, chain: 1 },
  { key: 'G', seq: 7, priority: 'medium', category: 'feature', complexity: 's', days: 5 },
  { key: 'I', seq: 8, priority: 'low', category: 'feature', complexity: null, days: 21 },
];

/** The backlog the parity cases rank, with what `forge next` scores each issue at. */
export async function seedFixtureBacklog() {
  const ids: Record<string, string> = {};
  const expected: Record<string, number> = {};
  for (const one of BACKLOG) {
    ids[one.key] = await seedIssue(one.seq, one);
    expected[one.key] = cliTotal({
      priority: one.priority ?? 'medium',
      category: one.category ?? null,
      complexity: one.complexity ?? null,
      reopen: one.reopen ?? 0,
      days: one.days ?? 0,
      chain: one.chain ?? 0,
    });
  }
  ids.IN_PROGRESS = await seedIssue(9, { priority: 'critical', status: 'in_progress', days: 90 });
  await edge(ids.E as string, ids.F as string);
  await edge(ids.F as string, ids.G as string);
  return { ids, expected };
}

export const keyOf = (ids: Record<string, string>, issueId: string) =>
  Object.entries(ids).find(([, id]) => id === issueId)?.[0] as string;
