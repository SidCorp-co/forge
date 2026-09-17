/**
 * The ground both repo-projection suites stand on: one schema, one binding, one
 * pull request payload to vary.
 *
 * It is a file rather than a shared `describe` because the write half and the
 * read half ask different questions of the same rows and the two suites are
 * long enough that one file carrying both was over its size budget. The hooks
 * are registered by the caller's `describe`, so each suite still gets a truncated
 * database per test.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

export const H1 = 'a'.repeat(40);
export const H2 = 'b'.repeat(40);
export const BASE = 'c'.repeat(40);

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  applyPullRequestEvent: typeof import('../../src/integrations/github/projection.js').applyPullRequestEvent;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  applyCheckRunEvent: typeof import('../../src/integrations/github/projection.js').applyCheckRunEvent;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  applyReviewEvent: typeof import('../../src/integrations/github/projection.js').applyReviewEvent;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  storeRefresh: typeof import('../../src/integrations/github/projection-refresh.js').storeRefresh;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  readPullRequestsForIssues: typeof import('../../src/integrations/repo-projection.js').readPullRequestsForIssues;
};

export interface ProjectionGround {
  harness: TestDatabase;
  mods: Mods;
  projectId: string;
  otherProjectId: string;
  bindingId: string;
  ownerId: string;
  ctx(): { projectId: string; bindingId: string };
  seedIssue(target: string, issSeq: number): Promise<string>;
  prEvent(over?: Record<string, unknown>): Record<string, unknown>;
  row(number?: number): Promise<Record<string, unknown> | undefined>;
}

function loadEnv(url: string): void {
  process.env.DATABASE_URL = url;
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
}

/** Registers the hooks in the calling `describe` and hands back the live state. */
export function projectionGround(): ProjectionGround {
  const g: ProjectionGround = {
    // Filled by the hooks below, before any `it` can read them.
    harness: undefined as unknown as TestDatabase,
    mods: undefined as unknown as Mods,
    projectId: '',
    otherProjectId: '',
    bindingId: '',
    ownerId: '',

    ctx: () => ({ projectId: g.projectId, bindingId: g.bindingId }),

    async seedIssue(target: string, issSeq: number): Promise<string> {
      const id = randomUUID();
      await g.harness.db.execute(sql`
        INSERT INTO issues (id, project_id, title, description, created_by_id, status, iss_seq, created_via)
        VALUES (${id}, ${target}, ${`planted ${issSeq}`}, null, ${g.ownerId}, 'open', ${issSeq}, 'system')
      `);
      return id;
    },

    prEvent(over: Record<string, unknown> = {}) {
      return {
        action: 'opened',
        pull_request: {
          number: 77,
          title: 'a change under review',
          html_url: 'https://github.com/SidCorp-co/forge/pull/77',
          state: 'open',
          draft: false,
          updated_at: '2026-09-17T01:00:00Z',
          head: { ref: 'ISS-4242-projection', sha: H1 },
          base: { ref: 'main', sha: BASE },
          ...over,
        },
        repository: { full_name: 'SidCorp-co/forge' },
      };
    },

    async row(number = 77) {
      const rows = (await g.harness.db.execute(sql`
        SELECT * FROM repo_pull_requests WHERE binding_id = ${g.bindingId} AND number = ${number}
      `)) as unknown as Array<Record<string, unknown>>;
      return rows[0];
    },
  };

  beforeAll(async () => {
    g.harness = await setupTestDatabase();
    loadEnv(g.harness.url);
    const projection = await import('../../src/integrations/github/projection.js');
    const refresh = await import('../../src/integrations/github/projection-refresh.js');
    const read = await import('../../src/integrations/repo-projection.js');
    g.mods = {
      applyPullRequestEvent: projection.applyPullRequestEvent,
      applyCheckRunEvent: projection.applyCheckRunEvent,
      applyReviewEvent: projection.applyReviewEvent,
      storeRefresh: refresh.storeRefresh,
      readPullRequestsForIssues: read.readPullRequestsForIssues,
    };
  }, 60_000);

  afterAll(async () => {
    if (g.harness) await g.harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(g.harness.db);
    const owner = await createTestUser(g.harness.db);
    g.ownerId = owner.id;
    g.projectId = (await createTestProject(g.harness.db, owner.id)).id;
    g.otherProjectId = (await createTestProject(g.harness.db, owner.id)).id;

    const connectionId = randomUUID();
    g.bindingId = randomUUID();
    await g.harness.db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
      VALUES (${connectionId}, 'user', ${owner.id}, 'github', true)
    `);
    await g.harness.db.execute(sql`
      INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, stages, active, config)
      VALUES (${g.bindingId}, ${connectionId}, ${g.projectId}, 'github', 'service', ARRAY[]::text[], true, '{}'::jsonb)
    `);
  });

  return g;
}
