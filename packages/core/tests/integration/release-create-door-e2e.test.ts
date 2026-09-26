/**
 * ISS-1127 criteria 1 and 9, judged at the create door rather than beside it.
 *
 * The judging run at 9fcf2d707 found readiness and the create agreeing on the
 * code and disagreeing on everything the operator reads: `NO_RUNNER_ONLINE`
 * came back from the create with a fallback sentence claiming no reading was
 * taken, and 51 waiting issues came back as `400 Invalid input` where readiness
 * said `RELEASE_ROSTER_OVERSIZE`. So every case below compares the WHOLE
 * headline entry — status, code, message, details — against readiness's own,
 * and the rest of the list against `alsoBlocking`, over the roster readiness
 * read. A case that compared codes alone passed at the head that failed.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let probe: Server;
let probeUrl = '';

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';

  const [batch, jwt, err, registry] = await Promise.all([
    import('../../src/release-batch/routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
    import('../../src/integrations/register-all.js'),
  ]);
  registry.registerAllIntegrations();
  signUserToken = jwt.signUserToken;
  app = new Hono();
  app.route('/api/projects', batch.releaseBatchRoutes);
  app.onError(err.errorHandler);

  probe = createServer((_req, res) => res.end('commit-live'));
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  probeUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/version`;
}, 60_000);

afterAll(async () => {
  if (probe) await new Promise<void>((done) => probe.close(() => done()));
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

afterEach(() => {
  vi.useRealTimers();
});

const LABEL = 'release-box';

interface World {
  projectId: string;
  userId: string;
  token: string;
}

async function seed(binding: Record<string, unknown> = {}): Promise<World> {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  await harness.db.execute(sql`
    UPDATE projects
       SET base_branch = 'main', live_branch = 'production',
           release_model = 'promote', release_strategy = 'merge-branch',
           repo_path = '/srv/app',
           environments = ${JSON.stringify({ live: { url: 'https://app.example.test' } })}::jsonb
     WHERE id = ${project.id}
  `);
  const connection = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
    VALUES (${connection}, 'user', ${user.id}, 'coolify', true)
  `);
  const config = {
    releaseRunnerLabel: LABEL,
    verify: { probes: [{ url: probeUrl }], timeoutSeconds: 5, stableReads: 1 },
    ...binding,
  };
  await harness.db.execute(sql`
    INSERT INTO integration_bindings (connection_id, project_id, provider, role, stages, active, config)
    VALUES (${connection}, ${project.id}, 'coolify', 'deploy', ARRAY['live'], true,
            ${JSON.stringify(config)}::jsonb)
  `);
  return { projectId: project.id, userId: user.id, token: await signUserToken(user.id) };
}

/** A box on this project; `lastSeen` null is one that never reported in. */
async function seedRunner(
  w: World,
  over: { name?: string; status?: string; lastSeen?: Date | null } = {},
): Promise<void> {
  const name = over.name ?? 'box';
  const device = await createTestDevice(harness.db, w.userId, { status: 'online', name });
  const lastSeen = over.lastSeen === undefined ? new Date() : over.lastSeen;
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
    VALUES (${randomUUID()}, ${w.projectId}, 'claude-code', ${device.id}, ${name},
            ${over.status ?? 'online'}, ${lastSeen === null ? null : lastSeen.toISOString()},
            ${JSON.stringify([LABEL])}::jsonb)
  `);
}

let seq = 0;
async function seedIssues(w: World, count: number, noted = true): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = randomUUID();
    seq += 1;
    const note = noted ? JSON.stringify({ section: 'Skip', userFacing: '-' }) : null;
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes, merged_at)
      VALUES (${id}, ${w.projectId}, ${seq}, ${`issue ${seq}`}, 'awaiting_release', ${w.userId},
              ${note}::jsonb, now() - make_interval(secs => ${count - i}))
    `);
    ids.push(id);
  }
  return ids;
}

interface Entry {
  code: string;
  httpStatus: number;
  message: string;
  details?: Record<string, unknown>;
}

async function readiness(w: World): Promise<Entry[]> {
  const res = await app.request(`/api/projects/${w.projectId}/release-readiness`, {
    headers: { Authorization: `Bearer ${w.token}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { blockers: Entry[] }).blockers;
}

async function create(w: World, issueIds: string[]) {
  const res = await app.request(`/api/projects/${w.projectId}/release-batches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${w.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueIds }),
  });
  return {
    status: res.status as number,
    body: (await res.json()) as {
      code?: string;
      message?: string;
      details?: Record<string, unknown> & { alsoBlocking?: Entry[] };
    },
  };
}

/**
 * The equivalence, whole: what readiness lists first is what the create
 * refuses by, word for word, and what readiness lists after it is what the
 * create carries beside it. Returns readiness's codes so a case can say which
 * state it built.
 */
async function expectDoorsAgree(w: World, issueIds: string[]): Promise<string[]> {
  const listed = await readiness(w);
  const refused = await create(w, issueIds);
  const [head, ...rest] = listed;

  expect(head).toBeDefined();
  expect(refused.status).toBe(head?.httpStatus);
  expect(refused.body.code).toBe(head?.code);
  expect(refused.body.message).toBe(head?.message);
  const { alsoBlocking, ...details } = refused.body.details ?? {};
  expect(details).toEqual(head?.details ?? {});
  expect(alsoBlocking ?? []).toEqual(rest);
  return listed.map((b) => b.code);
}

describe('the create door answers with the entry readiness listed first', () => {
  it('names each held box with its reading, not the fallback that says none was taken', async () => {
    // Frozen so both doors read the same "last seen" age; it is the one value
    // in the sentence that moves on its own between two requests.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date() });
    const w = await seed();
    await seedRunner(w, { name: 'judge-new-box', lastSeen: null });
    await seedRunner(w, {
      name: 'judge-offline-box',
      status: 'offline',
      lastSeen: new Date(Date.now() - 7_200_000),
    });
    const ids = await seedIssues(w, 1);

    const codes = await expectDoorsAgree(w, ids);

    expect(codes[0]).toBe('NO_RUNNER_ONLINE');
    const refused = await create(w, ids);
    expect(refused.body.message).toContain('judge-new-box');
    expect(refused.body.message).not.toContain('could not be taken');
  });

  it('refuses 51 waiting issues by RELEASE_ROSTER_OVERSIZE, not by the body schema', async () => {
    const w = await seed();
    await seedRunner(w);
    const ids = await seedIssues(w, 51);

    const codes = await expectDoorsAgree(w, ids);

    expect(codes[0]).toBe('RELEASE_ROSTER_OVERSIZE');
  });

  it('refuses an empty list on an empty gate by RELEASE_ROSTER_EMPTY', async () => {
    const w = await seed();
    await seedRunner(w);

    const codes = await expectDoorsAgree(w, []);

    expect(codes[0]).toBe('RELEASE_ROSTER_EMPTY');
  });

  it('carries the running batch id, where the create used to answer with none', async () => {
    const w = await seed();
    await seedRunner(w);
    const first = await seedIssues(w, 1);
    expect((await create(w, first)).status).toBe(201);
    const second = await seedIssues(w, 1);

    const codes = await expectDoorsAgree(w, second);

    expect(codes).toContain('BATCH_IN_FLIGHT');
  });

  it.each([
    ['a missing release note beside an empty pool', { noted: false, runner: false, binding: {} }],
    ['an empty pool alone', { noted: true, runner: false, binding: {} }],
    [
      'a probe url that is not a url',
      { noted: true, runner: true, binding: { verify: { probes: [{ url: 'example.test/v' }] } } },
    ],
  ])('agrees word for word on %s', async (_state, s) => {
    const w = await seed(s.binding);
    if (s.runner) await seedRunner(w);
    const ids = await seedIssues(w, 1, s.noted);

    await expectDoorsAgree(w, ids);
  });

  // A project that names no release runner is refused nothing, so there is no
  // refusal for the two doors to agree on: readiness lists nothing and the
  // create goes through (ISS-1275).
  it('opens a batch where no live binding names a release runner', async () => {
    const w = await seed({ releaseRunnerLabel: undefined });
    await seedRunner(w);
    const ids = await seedIssues(w, 1);

    const listed = await readiness(w);
    const created = await create(w, ids);

    expect(listed).toEqual([]);
    expect(created.status).toBe(201);
  });
});

describe('what the create door refuses that readiness does not list', () => {
  it('refuses an empty list beside a gate that holds issues, by name', async () => {
    const w = await seed();
    await seedRunner(w);
    await seedIssues(w, 1);

    const refused = await create(w, []);

    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('RELEASE_ISSUES_UNNAMED');
    expect(refused.body.message).toContain(
      `GET /api/projects/${w.projectId}/release-batches/roster`,
    );
    expect(await readiness(w)).toEqual([]);
  });

  it('lets a project reason outrank the empty list', async () => {
    const w = await seed();
    await seedIssues(w, 1);

    const refused = await create(w, []);

    expect(refused.body.code).toBe('RELEASE_POOL_EMPTY');
  });

  it('names only the issue a subset request selected', async () => {
    const w = await seed();
    await seedRunner(w);
    const [picked] = await seedIssues(w, 2, false);

    const refused = await create(w, [picked as string]);

    expect(refused.body.code).toBe('RELEASE_RECORD_MISSING');
    expect(refused.body.details?.issueIds).toEqual([picked]);
  });
});
