/**
 * `handleGitHubEvent` against real Postgres — the mirror of somebody else's
 * tracker, and the two things it must not do.
 *
 * The module had no test of any kind until 2026-09-06, which is why both
 * defects below survived: a mirror-close stamped `merged_at`, and every opened
 * pull request became a Forge issue. Both assertions are about a column, so
 * they are made against the column.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  handleGitHubEvent: typeof import('../../src/webhooks/github-adapter.js').handleGitHubEvent;
};

describe('handleGitHubEvent E2E', () => {
  let harness: TestDatabase;
  let mods: Mods;
  let projectId: string;
  let bindingId: string;

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

    mods = (await import('../../src/webhooks/github-adapter.js')) as unknown as Mods;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    projectId = project.id;

    const connectionId = randomUUID();
    bindingId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
      VALUES (${connectionId}, 'user', ${owner.id}, 'github', true)
    `);
    await harness.db.execute(sql`
      INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, stages, active, config)
      VALUES (${bindingId}, ${connectionId}, ${projectId}, 'github', 'service', ARRAY[]::text[], true, '{}'::jsonb)
    `);
  });

  // ISS-1062 — the handler takes the delivery's own binding rather than a project id, because the
  // projection half needs to know WHICH repository the delivery was about and whose credential may
  // re-read it. The binding here carries an empty config, which is what the forge-dev binding
  // actually held when this was measured: no owner, no repo, no installation. So the projection
  // stores what the payload said and re-reads nothing, which is the case below.
  function evCtx() {
    return {
      projectId,
      bindingId,
      config: {},
      secrets: {},
    };
  }

  async function rows() {
    return (await harness.db.execute(sql`
      SELECT external_id, status, merged_at, source FROM issues WHERE project_id = ${projectId}
    `)) as unknown as Array<{
      external_id: string | null;
      status: string;
      merged_at: Date | null;
      source: string;
    }>;
  }

  it('mirrors an opened GitHub issue', async () => {
    const r = await mods.handleGitHubEvent(evCtx(), 'issues', {
      action: 'opened',
      issue: { id: 7001, title: 'upstream bug', body: 'from GitHub' },
    });
    expect(r.actions).toBe(1);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]?.source).toBe('github');
    expect(all[0]?.external_id).toBe('7001');
  });

  it('closing a mirrored issue leaves merged_at NULL', async () => {
    await mods.handleGitHubEvent(evCtx(), 'issues', {
      action: 'opened',
      issue: { id: 7002, title: 'wontfix upstream', body: null },
    });
    const r = await mods.handleGitHubEvent(evCtx(), 'issues', {
      action: 'closed',
      issue: { id: 7002 },
    });
    expect(r.actions).toBe(1);

    const [row] = await rows();
    expect(row?.status).toBe('closed');
    expect(row?.merged_at).toBeNull();
  });

  it('an opened pull request creates no issue', async () => {
    const r = await mods.handleGitHubEvent(evCtx(), 'pull_request', { action: 'opened' });
    expect(r.actions).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  // ISS-1062 — the payload that USED to file an issue per opened PR now carries a head, a base and a
  // number, so it reaches the projection instead. This asserts the ISSUES table stays empty on the
  // shape that is no longer inert: the projection writes a row of its own, and a write that leaked
  // back into the mirror would show up here and nowhere else.
  it('a full pull_request payload writes a projection row and still no issue', async () => {
    const r = await mods.handleGitHubEvent(evCtx(), 'pull_request', {
      action: 'opened',
      pull_request: {
        number: 41,
        title: 'a change under review',
        state: 'open',
        updated_at: '2026-09-17T01:00:00Z',
        head: { ref: 'ISS-9999-nothing', sha: 'a'.repeat(40) },
        base: { ref: 'main', sha: 'b'.repeat(40) },
      },
      repository: { full_name: 'SidCorp-co/forge' },
    });
    expect(r.actions).toBe(1);
    expect(await rows()).toHaveLength(0);
    const projected = (await harness.db.execute(sql`
      SELECT number, head_ref, issue_id FROM repo_pull_requests WHERE binding_id = ${bindingId}
    `)) as unknown as Array<{ number: number; head_ref: string; issue_id: string | null }>;
    expect(projected).toHaveLength(1);
    expect(projected[0]?.number).toBe(41);
    expect(projected[0]?.issue_id).toBeNull();
  });
});
