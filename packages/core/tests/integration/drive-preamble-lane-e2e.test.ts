/**
 * The lane fork, asserted on the ASSEMBLED preamble rather than on its parts.
 *
 * `mandatoryPreambleBlocks` is one of five blocks `buildPipelinePreambleStructured`
 * joins, and a unit test of it passes while a sibling block says the opposite.
 * That is not hypothetical: on 2026-09-02 the two mandatory blocks were forked,
 * every unit assertion was green, and `POST /api/prompts/preview` on the live
 * deploy still handed the driver `` `waiting` `` — from `project-config`, whose
 * noProgressRounds line named the one park `issues/autonomous-park.ts` rewrites
 * at write time. The prompt instructed the exact move a net exists to catch.
 *
 * So the subject here is the whole document the agent reads, through the route
 * that builds it.
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CANONICAL_LADDER } from '../../src/prompt/facts/registry.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  type TestUser,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

describe('the assembled preamble forks on the lane', () => {
  let harness: TestDatabase;
  let app: Hono<AppVars>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.NODE_ENV = 'test';

    const { promptRoutes } = await import('../../src/prompt/routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;

    app = new Hono<AppVars>();
    app.use('*', requestId());
    app.route('/api/prompts', promptRoutes);
    app.onError(errorHandler);
  });

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function verifiedUser(): Promise<TestUser> {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    return user;
  }

  async function preambleFor(state: 'drive' | 'release_batch'): Promise<string> {
    const user = await verifiedUser();
    const project = await createTestProject(harness.db, user.id);
    const token = await signUserToken(user.id);
    const res = await app.request('/api/prompts/preview', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, state }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { systemPrompt: string }).systemPrompt;
  }

  it('names only parks the driver can actually write', async () => {
    const drive = await preambleFor('drive');

    expect(drive).toContain('needs_info');
    for (const rewritten of ['`waiting`', '`reopen`', '`on_hold`']) {
      expect(drive, `${rewritten} is rewritten at write time`).not.toContain(rewritten);
    }
  });

  it('carries no staged ladder', async () => {
    const drive = await preambleFor('drive');

    expect(drive).not.toContain('open → confirmed');
    expect(drive).toContain('## Driver Rules');
    expect(drive).toContain('forge-runner api');
  });

  it('leaves exactly the integration tools that have no CLI form', async () => {
    const drive = await preambleFor('drive');
    const named = new Set([...drive.matchAll(/forge_[a-z_.]+/g)].map((m) => m[0]));

    for (const gone of [
      'forge_step_start',
      'forge_step_handoff.write',
      'forge_issues.update',
      'forge_projects.get',
      'forge_config',
      'forge_memory.search',
    ]) {
      expect(named, `${gone} has a CLI form the driver is told to use`).not.toContain(gone);
    }
  });

  it('leaves the other arm carrying its ladder, its parks and its tools', async () => {
    const code = await preambleFor('release_batch');

    expect(code).toContain('## Pipeline Rules');
    expect(code).toContain(CANONICAL_LADDER.join(' → '));
    expect(code).toContain('`waiting`');
    expect(code).toContain('forge_step_start');
  });
});
