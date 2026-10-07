import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const HELD = '00000000-0000-4000-8000-000000000003';
const FREE = '00000000-0000-4000-8000-000000000004';
const LANDED = '00000000-0000-4000-8000-000000000005';

const state = vi.hoisted(() => ({ waiting: new Set<string>() }));

vi.mock('../middleware/auth.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../middleware/auth.js')>();
  return {
    ...real,
    requireAuth:
      () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
        c.set('userId', 'u1');
        await next();
      },
    assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
    restActor: () => ({ id: 'u1', agency: 'agent' }),
  };
});
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: async (projectId: string) => ({ projectId, role: 'owner', grants: [] }),
}));
vi.mock('../permissions/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../permissions/index.js')>()),
  requireHeld: () => undefined,
}));
vi.mock('../lib/data-egress.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/data-egress.js')>()),
  egressForRequest: async (_a: unknown, _p: unknown, _s: unknown, rows: unknown[]) => rows,
}));
const row = (id: string, seq: number, status: string) => ({
  id,
  projectId: PROJECT,
  issSeq: seq,
  title: `issue ${seq}`,
  status,
  mergedAt: null,
  mergedCommitSha: null,
  mergedLanding: null,
  workState: null,
});
vi.mock('./list-service.js', () => ({
  listIssues: async () => ({
    ok: true,
    rows: [row(HELD, 3, 'open'), row(FREE, 4, 'open'), row(LANDED, 5, 'awaiting_release')],
    total: 3,
  }),
}));
vi.mock('./issue-prefix-read.js', () => ({ activeIssuePrefix: async () => 'ISS' }));
vi.mock('./pipeline-health.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pipeline-health.js')>()),
  safeHydratePipelineHealthForIssues: async () => new Map(),
}));
vi.mock('./creator.js', () => ({ hydrateCreatorsForIssues: async () => new Map() }));
vi.mock('./ports.js', async (importOriginal) => {
  const { sql } = await import('drizzle-orm');
  return {
    ...(await importOriginal<typeof import('./ports.js')>()),
    policyGapsOf: async () => () => null,
    designUnapprovedSql: () => sql`false`,
    designHoldsOf: async () => new Map(),
  };
});
// the gate predicate and the gate itself answer from `state.waiting`, as the wait table would
vi.mock('../db/client.js', () => ({
  db: {
    execute: async () =>
      [HELD, FREE].map((id) => ({
        id,
        design_unapproved: false,
        contract_unsettled: state.waiting.has(id),
      })),
  },
}));
vi.mock('./contract-waits.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./contract-waits.js')>();
  return {
    ...real,
    contractHoldsOf: async (_p: string, issueIds: readonly string[]) =>
      new Map(
        issueIds
          .filter((id) => state.waiting.has(id))
          .map((id) => [
            id,
            real
              .contractWaitUnsettled([
                { issue: 'ISS-3', contract: 'catalog-api/admin-rest-v1', minVersion: '3.1.0' },
              ])
              .refusals.map((r) => r.detail)
              .join(' '),
          ]),
      ),
  };
});

const { issueProjectRoutes } = await import('./project-issue-routes.js');

interface ListRow {
  displayId: string;
  withheld?: { code: string; detail: string } | null;
}
async function list(): Promise<ListRow[]> {
  const app = new Hono().route('/', issueProjectRoutes);
  app.onError(errorHandler as never);
  const res = await app.request(`/${PROJECT}/issues`);
  const body = (await res.json()) as { items: ListRow[] };
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body.items;
}

beforeEach(() => {
  state.waiting = new Set([HELD]);
});

describe('the issue list forge next ranks from says which takeable rows a dispatch gate holds', () => {
  it('names the unsettled contract wait on the row every dispatch door refuses', async () => {
    const rows = await list();
    const held = rows.find((r) => r.displayId === 'ISS-3');
    expect(held?.withheld?.code).toBe('CONTRACT_WAIT_UNSETTLED');
    expect(held?.withheld?.detail).toContain('catalog-api/admin-rest-v1 >= 3.1.0');
  });

  it('carries null on a takeable row nothing holds, and on a row no run takes', async () => {
    const rows = await list();
    expect(rows.find((r) => r.displayId === 'ISS-4')?.withheld).toBeNull();
    expect(rows.find((r) => r.displayId === 'ISS-5')?.withheld).toBeNull();
  });

  it('frees the row once the wait settles', async () => {
    state.waiting = new Set();
    const rows = await list();
    expect(rows.every((r) => r.withheld === null)).toBe(true);
  });
});
