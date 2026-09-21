/**
 * ISS-1127 — the evening this issue was filed, reproduced end to end.
 *
 * Releasing twenty merged issues took five attempts, and each attempt revealed
 * exactly one blocker, only after the previous one was cleared:
 * `release-readiness` answered `gaps: []`, and `POST /release-batches` then
 * refused with `NO_RUNNER_ONLINE` — a reason that had been true the whole time
 * and appeared in no list anybody had read.
 *
 * So the property under test is an equivalence, and it is asserted in both
 * directions: an empty `blockers` is a promise that the create succeeds, and a
 * non-empty one names EVERY reason rather than the first the door reached.
 * Through the real route mount and a real database, because a refusal that is
 * mocked proves the mock.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

const LABEL = 'release-box';
const NOTE = { section: 'Skip', userFacing: '-' };

interface World {
  projectId: string;
  userId: string;
  token: string;
}

async function seed(over: { bindingConfig?: Record<string, unknown> } = {}): Promise<World> {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  // Everything `gaps` reports, declared — so a non-empty `blockers` beside an
  // empty `gaps` is the reproduction and not a half-configured fixture.
  await harness.db.execute(sql`
    UPDATE projects
       SET base_branch = 'main', live_branch = 'production',
           release_model = 'promote', release_strategy = 'merge-branch',
           repo_path = '/srv/app',
           environments = ${JSON.stringify({
             live: { url: 'https://app.example.test', commitUrl: probeUrl },
           })}::jsonb
     WHERE id = ${project.id}
  `);
  for (const slug of ['build-commands', 'test-commands', 'release-procedure']) {
    await harness.db.execute(sql`
      INSERT INTO knowledge_entries (id, project_id, slug, title, body, kind)
      VALUES (${randomUUID()}, ${project.id}, ${slug}, ${slug}, 'declared', 'rule')
    `);
  }
  const connection = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
    VALUES (${connection}, 'user', ${user.id}, 'coolify', true)
  `);
  await harness.db.execute(sql`
    INSERT INTO integration_bindings (connection_id, project_id, provider, role, stages, active, config)
    VALUES (${connection}, ${project.id}, 'coolify', 'deploy', ARRAY['live'], true, ${JSON.stringify(
      over.bindingConfig ?? {
        releaseRunnerLabel: LABEL,
        rollback: { mode: 'coolify-image' },
        verify: { probes: [{ url: probeUrl }], timeoutSeconds: 5, stableReads: 1 },
      },
    )}::jsonb)
  `);
  return { projectId: project.id, userId: user.id, token: await signUserToken(user.id) };
}

async function seedRunner(w: World): Promise<void> {
  const device = await createTestDevice(harness.db, w.userId, { status: 'online' });
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
    VALUES (${randomUUID()}, ${w.projectId}, 'claude-code', ${device.id}, 'box', 'online', now(),
            ${JSON.stringify([LABEL])}::jsonb)
  `);
}

let seq = 0;
async function seedIssue(w: World, note: unknown = NOTE): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes, merged_at)
    VALUES (${id}, ${w.projectId}, ${seq}, ${`issue ${seq}`}, 'awaiting_release', ${w.userId},
            ${note === null ? null : JSON.stringify(note)}::jsonb, now())
  `);
  return id;
}

async function readiness(w: World) {
  const res = await app.request(`/api/projects/${w.projectId}/release-readiness`, {
    headers: { Authorization: `Bearer ${w.token}` },
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      gaps: string[];
      blockers: Array<{ code: string; message: string; evaluated: boolean }>;
      warnings: Array<{ code: string }>;
    },
  };
}

async function createBatch(w: World, issueIds: string[]) {
  const res = await app.request(`/api/projects/${w.projectId}/release-batches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${w.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueIds }),
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      code?: string;
      message?: string;
      details?: { alsoBlocking?: Array<{ code: string }> };
    },
  };
}

describe('release-readiness and the create door answer the same question', () => {
  it('reports no blocker and then lets the release start, which is the equivalence', async () => {
    const w = await seed();
    await seedRunner(w);
    const issue = await seedIssue(w);

    const before = await readiness(w);
    const created = await createBatch(w, [issue]);

    expect(before.body.blockers).toEqual([]);
    expect(created.status).toBe(201);
  });

  it('names the fleet reason while gaps is empty — the evening this was filed', async () => {
    const w = await seed();
    await seedIssue(w);

    const answer = await readiness(w);

    expect(answer.body.gaps).toEqual([]);
    expect(answer.body.blockers.map((b) => b.code)).toContain('RELEASE_POOL_EMPTY');
  });

  it('names the roster reason and the fleet reason together, not one per attempt', async () => {
    const w = await seed();
    await seedIssue(w, null);

    const codes = (await readiness(w)).body.blockers.map((b) => b.code);

    expect(codes).toContain('RELEASE_RECORD_MISSING');
    expect(codes).toContain('RELEASE_POOL_EMPTY');
  });

  it('refuses the create by the code readiness printed, and carries the rest with it', async () => {
    const w = await seed();
    const issue = await seedIssue(w, null);

    const answer = await readiness(w);
    const refused = await createBatch(w, [issue]);

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('RELEASE_RECORD_MISSING');
    expect(refused.body.message).toBe(
      answer.body.blockers.find((b) => b.code === 'RELEASE_RECORD_MISSING')?.message,
    );
    expect(refused.body.details?.alsoBlocking?.map((b) => b.code)).toContain('RELEASE_POOL_EMPTY');
  });

  it('reports an empty roster rather than promising a release of nothing', async () => {
    const w = await seed();
    await seedRunner(w);

    const codes = (await readiness(w)).body.blockers.map((b) => b.code);

    expect(codes).toContain('RELEASE_ROSTER_EMPTY');
  });

  it('names a probe url that is not a url, where the create used to throw a 500', async () => {
    const w = await seed({
      bindingConfig: {
        releaseRunnerLabel: LABEL,
        rollback: { mode: 'coolify-image' },
        verify: { probes: [{ url: 'forge-beta-api.example/version' }] },
      },
    });
    await seedRunner(w);
    const issue = await seedIssue(w);

    const answer = await readiness(w);
    const refused = await createBatch(w, [issue]);

    expect(answer.body.blockers.map((b) => b.code)).toContain('RELEASE_PROBES_UNREADABLE');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('RELEASE_PROBES_UNREADABLE');
  });

  it('reports an unmet runner-label preference as a warning that stops nothing', async () => {
    const w = await seed();
    const device = await createTestDevice(harness.db, w.userId, { status: 'online' });
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
      VALUES (${randomUUID()}, ${w.projectId}, 'claude-code', ${device.id}, 'unlabelled',
              'online', now(), '[]'::jsonb)
    `);
    const issue = await seedIssue(w);

    const answer = await readiness(w);
    const created = await createBatch(w, [issue]);

    expect(answer.body.warnings.map((x) => x.code)).toContain('RELEASE_RUNNER_PREFERENCE_UNMET');
    expect(answer.body.blockers).toEqual([]);
    expect(created.status).toBe(201);
  });
});
