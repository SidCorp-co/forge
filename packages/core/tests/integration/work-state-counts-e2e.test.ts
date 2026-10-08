/**
 * ISS-1156 — every screen's count of work is one fold. Real Postgres: one project holds an issue at
 * every status, some with a question a person owes an answer, and the figures each endpoint
 * publishes for it at that moment are read back and compared.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OPEN_WORK_STATES,
  openWorkTotal,
  STATUS_WORK_STATE,
  WORK_STATES,
  type WorkState,
  workStateOf,
} from '../../src/issues/work-state.js';
import type { PulseResponse } from '../../src/me/pulse-types.js';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const ADMIN_EMAIL = 'work-state-admin@test.forge.local';

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let projectId: string;
let ownerId: string;
let token: string;
let seq = 0;
let signToken: (userId: string) => Promise<string>;

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
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;

  const { searchRoutes } = await import('../../src/issues/search.js');
  const { projectHealthRoutes } = await import('../../src/projects/health-routes.js');
  const { mePulseRoutes } = await import('../../src/me/pulse-routes.js');
  const { adminAggregateRoutes } = await import('../../src/admin/aggregate-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  const { signUserToken } = await import('../../src/auth/jwt.js');

  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', searchRoutes);
  app.route('/api/projects', projectHealthRoutes);
  app.route('/api/me', mePulseRoutes);
  app.route('/api/admin', adminAggregateRoutes);
  app.onError(errorHandler);

  signToken = signUserToken;
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  // The admin gate and the project membership both read this one user.
  ownerId = (await createTestUser(harness.db, { email: ADMIN_EMAIL })).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${ownerId}`);
  token = await signToken(ownerId);
  projectId = (await createTestProject(harness.db, ownerId)).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
});

async function insertIssue(status: string, extra?: { detector?: boolean }): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, detector_key, merged_at)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId},
            ${extra?.detector ? `detector-${seq}` : null},
            ${status === 'closed' ? sql`now()` : null})
  `);
  return id;
}

async function openQuestion(issueId: string, blockerKind = 'human'): Promise<void> {
  const step = {
    round: 1,
    prompt: 'Publish now, or hold?',
    askedAt: '2026-09-27T10:00:00Z',
    answerShape: 'free_text',
    needed: 'publish or hold',
  };
  await harness.db.execute(sql`
    INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps)
    VALUES (${randomUUID()}, ${projectId}, ${issueId}, 'open', ${blockerKind}, ${JSON.stringify([step])}::jsonb)
  `);
}

const issueStatuses = Object.keys(STATUS_WORK_STATE) as Array<keyof typeof STATUS_WORK_STATE>;

const auth = () => ({ Authorization: `Bearer ${token}` });

async function search(query: string) {
  const res = await app.request(`/api/projects/${projectId}/issues/search?${query}`, {
    headers: auth(),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    items: Array<{ id: string; status: string }>;
    total: number;
    buckets?: { byStatus: Record<string, number>; byWorkState: Record<WorkState, number> };
  };
}

async function health() {
  const res = await app.request('/api/projects/health', { headers: auth() });
  expect(res.status).toBe(200);
  const rows = (await res.json()) as Array<{
    id: string;
    totalActive: number;
    work: Record<WorkState, number>;
  }>;
  const row = rows.find((r) => r.id === projectId);
  if (!row) throw new Error('the health response holds no row for the seeded project');
  return row;
}

async function pulse() {
  const res = await app.request('/api/me/pulse', { headers: auth() });
  expect(res.status).toBe(200);
  return (await res.json()) as PulseResponse;
}

/** One issue at every status; a person owes an answer on the in-flight, open and release-gate ones. */
async function seedEveryStatus() {
  const ids: Record<string, string> = {};
  for (const status of issueStatuses) ids[status] = await insertIssue(status);
  // A second issue at the same status for each state, so a count of one is never a count of one status.
  await insertIssue('open');
  await insertIssue('in_progress');
  await insertIssue('dropped');
  // A question a person owes: lifts open and in flight, moves nothing else.
  await openQuestion(ids.in_progress as string);
  await openQuestion(ids.open as string);
  await openQuestion(ids.awaiting_release as string);
  await openQuestion(ids.closed as string);
  await openQuestion(ids.draft as string);
  // A question for a peer is no person's to answer, and moves nothing.
  await openQuestion(ids.testing as string, 'master_or_peer');
  return ids;
}

/**
 * What a reader computes by hand from the seed: seventeen statuses plus a second open, in_progress
 * and dropped issue is twenty issues. A person's question lifts the open and in_progress ones that
 * hold one into Blocked on a person; the peer's question on testing, and every question on the
 * release gate, a draft or finished work, move nothing.
 */
const EXPECTED: Record<WorkState, number> = {
  open: 1,
  in_flight: 7,
  awaiting_release: 2,
  blocked_on_person: 6,
  draft: 1,
  finished: 3,
};

describe('the same project, counted by every endpoint that counts it', () => {
  it('has the hand-computed count in each state, so the comparisons below compare something', async () => {
    await seedEveryStatus();
    const { buckets } = await search('withBuckets=1&limit=1');
    expect(buckets?.byWorkState).toEqual(EXPECTED);
  });

  it('reports one figure per open state from the search, the health row and the pulse', async () => {
    await seedEveryStatus();
    const bySearch = (await search('withBuckets=1&limit=1')).buckets?.byWorkState;
    const byHealth = (await health()).work;
    const byPulse = (await pulse()).work.buckets;
    for (const state of OPEN_WORK_STATES) {
      expect([state, byHealth[state]]).toEqual([state, bySearch?.[state]]);
      expect([state, byPulse[state]]).toEqual([state, bySearch?.[state]]);
    }
  });

  it('reports the same figure of open work from health, the pulse and the admin table, and counts no draft, closed or dropped issue in it', async () => {
    await seedEveryStatus();
    const expectedOpen = openWorkTotal(EXPECTED);
    const row = await health();
    expect(row.totalActive).toBe(expectedOpen);

    const buckets = (await pulse()).work.buckets;
    expect(OPEN_WORK_STATES.reduce((n, s) => n + buckets[s], 0)).toBe(expectedOpen);

    const adminRes = await app.request('/api/admin/workspaces?window=7d&limit=100', {
      headers: auth(),
    });
    expect(adminRes.status).toBe(200);
    const rows = (
      (await adminRes.json()) as { items: Array<{ projectId: string; openIssues: number }> }
    ).items;
    expect(rows.find((r) => r.projectId === projectId)?.openIssues).toBe(expectedOpen);
  });

  it('adds the six search counts up to the total the same query returns with no work state', async () => {
    await seedEveryStatus();
    const filters = [
      '',
      '&origin=human',
      '&origin=detector',
      '&priority=medium',
      '&status=in_progress',
      '&status=closed&status=dropped',
      '&statusNot=closed',
      '&statusNot=closed&statusNot=draft&origin=human',
    ];
    for (const extra of filters) {
      const body = await search(`withBuckets=1&limit=1${extra}`);
      const sum = WORK_STATES.reduce((n, s) => n + (body.buckets?.byWorkState[s] ?? 0), 0);
      expect([extra, sum]).toEqual([extra, body.total]);
    }
  });

  it('keeps every count under the chosen work state, so the other segments do not read zero', async () => {
    await seedEveryStatus();
    const all = (await search('withBuckets=1&limit=1')).buckets?.byWorkState;
    const chosen = (await search('withBuckets=1&limit=1&workState=in_flight')).buckets?.byWorkState;
    expect(chosen).toEqual(all);
  });

  it('narrows the six counts to a status filter, and keeps the per-status counts whole', async () => {
    await seedEveryStatus();
    const body = await search('withBuckets=1&limit=1&status=in_progress');
    expect(body.buckets?.byWorkState).toEqual({
      open: 0,
      in_flight: 1,
      awaiting_release: 0,
      blocked_on_person: 1,
      draft: 0,
      finished: 0,
    });
    // The seed holds two in_progress issues, one of them with a question a person owes: that one
    // reads Blocked on a person, so a status filter never keeps a count another state holds.
    expect(body.total).toBe(2);
    expect(body.buckets?.byStatus.closed, 'the per-status counts are not narrowed by status').toBe(
      1,
    );
  });

  it('counts every state as zero under a module that does not exist, and still sends the counts', async () => {
    await seedEveryStatus();
    const body = await search('withBuckets=1&limit=1&module=no-such-module');
    expect(body.total).toBe(0);
    expect(body.buckets?.byWorkState).toEqual({
      open: 0,
      in_flight: 0,
      awaiting_release: 0,
      blocked_on_person: 0,
      draft: 0,
      finished: 0,
    });
  });

  it('counts a machine-filed issue under its own state and narrows every count by origin', async () => {
    await insertIssue('draft', { detector: true });
    await insertIssue('draft');
    await insertIssue('in_progress', { detector: true });
    const body = await search('withBuckets=1&limit=1&origin=detector');
    expect(body.buckets?.byWorkState).toMatchObject({ draft: 1, in_flight: 1 });
    expect(body.total).toBe(2);
  });
});

describe('an archived issue', () => {
  it('is out of every endpoint’s count, and back in the search’s when archived rows are asked for', async () => {
    const dropped = await insertIssue('dropped');
    await insertIssue('dropped');
    await harness.db.execute(sql`UPDATE issues SET archived_at = now() WHERE id = ${dropped}`);
    expect((await search('withBuckets=1&limit=1')).buckets?.byWorkState.finished).toBe(1);
    expect((await health()).work.finished).toBe(1);
    expect((await pulse()).work.perProject.length).toBe(1);
    const withArchived = await search('withBuckets=1&limit=1&includeArchived=true');
    expect(withArchived.buckets?.byWorkState.finished).toBe(2);
  });
});

describe('the workState filter', () => {
  it('lists, for each state, exactly the issues that state counts, a question included', async () => {
    const ids = await seedEveryStatus();
    for (const state of WORK_STATES) {
      const body = await search(`workState=${state}&limit=200`);
      expect([state, body.items.length]).toEqual([state, EXPECTED[state]]);
      for (const item of body.items) {
        const owes = [
          ids.in_progress,
          ids.open,
          ids.awaiting_release,
          ids.closed,
          ids.draft,
        ].includes(item.id);
        expect([state, item.status, workStateOf(item.status as never, owes)]).toEqual([
          state,
          item.status,
          state,
        ]);
      }
    }
  });

  it('puts an in-flight issue a person owes an answer under Blocked on a person and not under In flight', async () => {
    const ids = await seedEveryStatus();
    const blocked = (await search('workState=blocked_on_person&limit=200')).items.map((i) => i.id);
    const flying = (await search('workState=in_flight&limit=200')).items.map((i) => i.id);
    expect(blocked).toContain(ids.in_progress);
    expect(flying).not.toContain(ids.in_progress);
  });

  it('leaves the release gate, drafts and finished work where their status puts them, whatever is asked of a person', async () => {
    const ids = await seedEveryStatus();
    const states = Object.fromEntries(
      await Promise.all(
        WORK_STATES.map(
          async (s) =>
            [s, (await search(`workState=${s}&limit=200`)).items.map((i) => i.id)] as const,
        ),
      ),
    ) as Record<WorkState, string[]>;
    expect(states.awaiting_release).toContain(ids.awaiting_release);
    expect(states.draft).toContain(ids.draft);
    expect(states.finished).toContain(ids.closed);
  });

  it('refuses a value outside the six by name, in the response', async () => {
    const res = await app.request(
      `/api/projects/${projectId}/issues/search?workState=${encodeURIComponent('Needs you')}`,
      { headers: auth() },
    );
    expect(res.status).toBe(400);
    const text = JSON.stringify(await res.json());
    expect(text).toMatch(/workState/);
    for (const state of WORK_STATES) expect(text).toContain(state);
  });

  it('agrees with the status map: with no question owed, each status lists under its own state', async () => {
    for (const status of issueStatuses) await insertIssue(status);
    for (const state of WORK_STATES) {
      const listed = (await search(`workState=${state}&limit=200`)).items
        .map((i) => i.status)
        .sort();
      const expected = issueStatuses.filter((s) => STATUS_WORK_STATE[s] === state).sort();
      expect([state, listed]).toEqual([state, expected]);
    }
  });
});
