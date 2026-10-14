/**
 * An agent's `closed` on a project that declares a release chain and has no active live deploy
 * binding is refused by name — 409 `RELEASE_TARGET_UNDECLARED` from the single route, and the
 * same code as the batch route's skip reason — through the real routes and a real Postgres.
 * Before, the error escaped the transition as a 500 `INTERNAL_ERROR`.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';
process.env.PAT_PEPPER ??= 'integration-test-pat-pepper-padded-to-32-chars-long';

import {
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
let mintPat: typeof import('../../src/auth/pat.js')['mintPat'];

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const [transitionMod, extrasMod, patMod, errMod] = await Promise.all([
    import('../../src/issues/transition.js'),
    import('../../src/issues/extras-routes.js'),
    import('../../src/auth/pat.js'),
    import('../../src/middleware/error.js'),
  ]);
  mintPat = patMod.mintPat;
  app = new Hono();
  app.route('/api/issues', transitionMod.transitionRoutes);
  app.route('/api/issues', extrasMod.issueExtrasRoutes);
  app.onError(errMod.errorHandler);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

interface World {
  projectId: string;
  agentToken: string;
  humanToken: string;
  userId: string;
}

/** A project with the given release chain and no deploy binding of any stage. */
async function seedWorld(chain: unknown[]): Promise<World> {
  const human = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  const project = await createTestProject(harness.db, human.id);
  const agent = await createTestUser(harness.db, { kind: 'agent' });
  await createTestProjectMember(harness.db, { userId: agent.id, projectId: project.id });
  await harness.db.execute(
    sql`UPDATE projects SET release_chain = ${JSON.stringify(chain)}::jsonb, base_branch = 'main' WHERE id = ${project.id}::uuid`,
  );
  const mint = (userId: string, name: string) =>
    mintPat({ userId, name, boundProjectId: project.id }).then((m) => m.plaintext);
  return {
    projectId: project.id,
    agentToken: await mint(agent.id, 'an agent'),
    humanToken: await mint(human.id, 'a person'),
    userId: human.id,
  };
}

async function seedIssue(w: World): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, created_by_id, status, merged_at, release_notes)
    VALUES (${id}::uuid, ${w.projectId}::uuid, 'work with nowhere to release', ${w.userId}::uuid,
            'testing', now(), '{"section":"Skip","userFacing":"-"}'::jsonb)
  `);
  return id;
}

async function statusOf(id: string): Promise<string> {
  const rows = await harness.db.execute<{ status: string }>(
    sql`SELECT status FROM issues WHERE id = ${id}::uuid`,
  );
  return (rows[0] as { status: string }).status;
}

const close = (id: string, token: string) =>
  app.request(`/api/issues/${id}/transition`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ toStatus: 'closed' }),
  });

const closeBatch = (ids: string[], token: string) =>
  app.request('/api/issues/batch', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ids, data: { status: 'closed' } }),
  });

const ONE_BRANCH = [{ branch: 'main' }];
const TWO_BRANCHES = [{ branch: 'main' }, { branch: 'release', from: 'merge-branch' }];

describe('an agent closes on a project whose release chain has nowhere to land', () => {
  it.each([
    ['one branch', ONE_BRANCH],
    ['two branches', TWO_BRANCHES],
  ])(
    'is refused 409 RELEASE_TARGET_UNDECLARED on a chain of %s, and the issue stays where it was',
    async (_name, chain) => {
      const w = await seedWorld(chain);
      const id = await seedIssue(w);

      const res = await close(id, w.agentToken);

      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        code?: string;
        message?: string;
        details?: Record<string, unknown>;
      };
      expect(body.code).toBe('RELEASE_TARGET_UNDECLARED');
      expect(body.message).toContain("no active deploy binding carrying the 'live' stage");
      expect(body.message).toContain('choose "Repository, no release" under Shape & release');
      expect(body.details).toMatchObject({ projectId: w.projectId, releaseChain: chain });
      expect(await statusOf(id)).toBe('testing');
    },
    120_000,
  );

  it('is skipped by the batch route under its own reason', async () => {
    const w = await seedWorld(ONE_BRANCH);
    const id = await seedIssue(w);

    const res = await closeBatch([id], w.agentToken);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      updated: unknown[];
      skipped: Array<{ id: string; reason: string }>;
    };
    expect(body.updated).toEqual([]);
    expect(body.skipped).toEqual([{ id, reason: 'release_target_undeclared' }]);
    expect(await statusOf(id)).toBe('testing');
  }, 120_000);

  it('is still closed by a person, who makes the shipped claim deliberately', async () => {
    const w = await seedWorld(ONE_BRANCH);
    const id = await seedIssue(w);

    expect((await close(id, w.humanToken)).status).toBe(200);
    expect(await statusOf(id)).toBe('closed');
  }, 120_000);

  it('closes without a gate on a chain that ships nothing', async () => {
    const w = await seedWorld([]);
    const id = await seedIssue(w);

    expect((await close(id, w.agentToken)).status).toBe(200);
    expect(await statusOf(id)).toBe('closed');
  }, 120_000);
});
