/**
 * ISS-1217 — the sid-desk reproduction against real rows: eight closed issues whose commits sit
 * on `staging` and not on `master` at `52c66950`. GitHub is stubbed at the repository client, the
 * one door every reading takes; the projects, issues, prefixes and membership are Postgres.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

const STAGING = 'f'.repeat(40);
const MASTER = '52c66950'.padEnd(40, '0');
const OBSERVED = '11d071b3'.padEnd(40, '0');
const NOT_LIVE = [419, 423, 429, 432, 434, 435, 440, 442];

const waiting = [
  ...NOT_LIVE.filter((n) => n !== 442).map((n, i) => ({
    sha: `${String(i + 1).padStart(2, '0')}`.padEnd(40, 'a'),
    commit: {
      message:
        i % 2 ? `fix(desk): change (ISS-${n})` : `Merge pull request #${n} from sid/ISS-${n}-slug`,
    },
  })),
  { sha: OBSERVED, commit: { message: 'a squash whose message names no issue' } },
];

const unbound = new Set<string>();
let compares = 0;

vi.mock('../../src/integrations/github/client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/integrations/github/client.js')>();
  return {
    ...real,
    githubRepoClient: async (projectId: string) => {
      if (unbound.has(projectId)) {
        throw new real.GitHubClientError('no_binding', 'this project has no active GitHub binding');
      }
      return {
        bindingId: 'b',
        appId: '1',
        owner: 'SidCorp-co',
        repo: 'sid-desk',
        fullName: 'SidCorp-co/sid-desk',
        get: async (path: string) => {
          if (path.endsWith('/heads/staging')) return { object: { sha: STAGING } };
          if (path.endsWith('/heads/master')) return { object: { sha: MASTER } };
          compares += 1;
          return { ahead_by: waiting.length, commits: waiting };
        },
        publish: async () => {
          throw new Error('a live reading must not publish');
        },
      };
    },
  };
});

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let forgetAllLiveReadings: () => void;
let applyProjectedEvent: typeof import('../../src/integrations/github/projection-events.js').applyProjectedEvent;

async function project(userId: string, release: 'promote' | 'publish') {
  const p = await createTestProject(harness.db, userId);
  await createTestProjectMember(harness.db, { userId, projectId: p.id, role: 'admin' });
  await harness.db.execute(sql`
    UPDATE projects SET base_branch = 'staging',
      release_model = ${release},
      live_branch = ${release === 'promote' ? 'master' : null},
      release_strategy = ${release === 'promote' ? 'merge-branch' : null}
    WHERE id = ${p.id}
  `);
  return p;
}

async function issue(args: {
  projectId: string;
  userId: string;
  seq: number;
  status?: string;
  merged?: boolean;
  sha?: string | undefined;
}) {
  const id = randomUUID();
  const merged = args.merged ?? true;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at, merged_commit_sha)
    VALUES (${id}, ${args.projectId}, ${args.seq}, ${`ISS-${args.seq} on sid-desk`},
            ${args.status ?? 'closed'}, ${args.userId},
            ${merged ? sql`now() - interval '1 hour'` : sql`NULL`}, ${args.sha ?? null})
  `);
  return id;
}

async function signedIn() {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  return { user, token: await signUserToken(user.id) };
}

async function get<T>(path: string, token: string): Promise<T> {
  const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

describe('a closed issue whose work never reached the live branch (ISS-1217)', () => {
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

    const { issueProjectRoutes, issueRoutes } = await import('../../src/issues/routes.js');
    const { mePulseRoutes } = await import('../../src/me/pulse-routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    ({ signUserToken } = await import('../../src/auth/jwt.js'));
    ({ forgetAllLiveReadings } = await import('../../src/projects/live-reading.js'));
    ({ applyProjectedEvent } = await import('../../src/integrations/github/projection-events.js'));

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/projects', issueProjectRoutes);
    app.route('/api/issues', issueRoutes);
    app.route('/api/me', mePulseRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    forgetAllLiveReadings();
    unbound.clear();
    compares = 0;
  });

  type Reach = {
    state: string;
    evidence?: Array<{ sha: string; via: string }>;
    reason?: string;
  } | null;

  it('places each of the eight rows off master, on both issue reads and in the pulse', async () => {
    const { user, token } = await signedIn();
    const desk = await project(user.id, 'promote');
    const ids = new Map<number, string>();
    for (const n of NOT_LIVE) {
      ids.set(
        n,
        await issue({
          projectId: desk.id,
          userId: user.id,
          seq: n,
          sha: n === 442 ? OBSERVED : undefined,
        }),
      );
    }
    const shipped = await issue({ projectId: desk.id, userId: user.id, seq: 400 });

    for (const n of NOT_LIVE) {
      const byId = await get<{ liveReach: Reach }>(`/api/issues/${ids.get(n)}`, token);
      expect(byId.liveReach?.state, `ISS-${n}`).toBe('not_on_live');
      const byKey = await get<{ liveReach: Reach }>(
        `/api/projects/${desk.id}/issues/by-display/ISS-${n}`,
        token,
      );
      expect(byKey.liveReach).toEqual(byId.liveReach);
    }
    const observed = await get<{ liveReach: Reach }>(`/api/issues/${ids.get(442)}`, token);
    expect(observed.liveReach?.evidence).toEqual([
      expect.objectContaining({ sha: OBSERVED, via: 'merged_commit' }),
    ]);

    const clear = await get<{ liveReach: Reach }>(`/api/issues/${shipped}`, token);
    expect(clear.liveReach).toMatchObject({
      state: 'none_waiting',
      baseBranch: 'staging',
      liveBranch: 'master',
      baseSha: STAGING,
      liveSha: MASTER,
    });

    const pulse = await get<PulseResponse>('/api/me/pulse', token);
    expect(pulse.work.notOnLive.total).toBe(8);
    expect(pulse.work.notOnLive.shown.map((i) => i.issueRef).sort()).toEqual(
      NOT_LIVE.map((n) => `ISS-${n}`).sort(),
    );
    expect(pulse.work.liveUnmeasured.total).toBe(0);
  });

  it('counts only closed rows in the pulse, and gives nothing on a non-promote project or an unmerged row', async () => {
    const { user, token } = await signedIn();
    const desk = await project(user.id, 'promote');
    const other = await project(user.id, 'publish');
    await issue({ projectId: desk.id, userId: user.id, seq: 419, status: 'awaiting_release' });
    const open = await issue({
      projectId: desk.id,
      userId: user.id,
      seq: 423,
      status: 'open',
      merged: false,
    });
    const elsewhere = await issue({ projectId: other.id, userId: user.id, seq: 429 });

    expect((await get<{ liveReach: Reach }>(`/api/issues/${open}`, token)).liveReach).toBeNull();
    expect(
      (await get<{ liveReach: Reach }>(`/api/issues/${elsewhere}`, token)).liveReach,
    ).toBeNull();
    const pulse = await get<PulseResponse>('/api/me/pulse', token);
    expect(pulse.work.notOnLive.total).toBe(0);
  });

  it('names a promote project Forge cannot compare, and says why on its rows', async () => {
    const { user, token } = await signedIn();
    const desk = await project(user.id, 'promote');
    unbound.add(desk.id);
    const row = await issue({ projectId: desk.id, userId: user.id, seq: 419 });

    const reach = (await get<{ liveReach: Reach }>(`/api/issues/${row}`, token)).liveReach;
    expect(reach).toMatchObject({
      state: 'unmeasured',
      reason: 'this project has no active GitHub binding',
    });
    const pulse = await get<PulseResponse>('/api/me/pulse', token);
    expect(pulse.work.liveUnmeasured.shown).toEqual([
      expect.objectContaining({
        id: desk.id,
        liveBranch: 'master',
        reason: 'this project has no active GitHub binding',
      }),
    ]);
    expect(pulse.work.notOnLive.total).toBe(0);
  });

  it('compares again after a push delivery for the project, and not after a review delivery', async () => {
    const { user, token } = await signedIn();
    const desk = await project(user.id, 'promote');
    const row = await issue({ projectId: desk.id, userId: user.id, seq: 419 });
    const ctx = {
      projectId: desk.id,
      bindingId: randomUUID(),
      config: { owner: 'SidCorp-co', repo: 'sid-desk' },
      secrets: {},
    };

    await get(`/api/issues/${row}`, token);
    await get(`/api/issues/${row}`, token);
    expect(compares).toBe(1);
    await applyProjectedEvent(ctx, 'pull_request_review', { action: 'submitted' });
    await get(`/api/issues/${row}`, token);
    expect(compares).toBe(1);
    await applyProjectedEvent(ctx, 'push', { ref: 'refs/heads/master' });
    await get(`/api/issues/${row}`, token);
    expect(compares).toBe(2);
  });
});
