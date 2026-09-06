/**
 * `handleGitHubEvent` against real Postgres — the mirror of somebody else's
 * tracker, and the two things it must not do.
 *
 * The module had no test of any kind until 2026-09-06, which is why both
 * defects below survived: a mirror-close stamped `merged_at`, and every opened
 * pull request became a Forge issue. Both assertions are about a column, so
 * they are made against the column.
 */

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
  });

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
    const r = await mods.handleGitHubEvent(projectId, 'issues', {
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
    await mods.handleGitHubEvent(projectId, 'issues', {
      action: 'opened',
      issue: { id: 7002, title: 'wontfix upstream', body: null },
    });
    const r = await mods.handleGitHubEvent(projectId, 'issues', {
      action: 'closed',
      issue: { id: 7002 },
    });
    expect(r.actions).toBe(1);

    const [row] = await rows();
    expect(row?.status).toBe('closed');
    expect(row?.merged_at).toBeNull();
  });

  it('an opened pull request creates no issue', async () => {
    const r = await mods.handleGitHubEvent(projectId, 'pull_request', { action: 'opened' });
    expect(r.actions).toBe(0);
    expect(await rows()).toHaveLength(0);
  });
});
