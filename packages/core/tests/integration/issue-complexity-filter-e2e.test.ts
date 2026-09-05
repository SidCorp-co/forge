/**
 * `complexity` as a FILTER, not just a projected field (ISS-912).
 *
 * The projection shipped on all three shapes while nothing could narrow by the
 * value, so this pins the narrowing end-to-end through MCP — the only place a
 * filter accepted at the boundary and dropped in the hand-copied mapping is
 * visible at all.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { connectClientAsDevice, parseToolResult } from '../helpers/mcp-harness.js';

describe('forge_issues list: complexity filter (ISS-912)', () => {
  let harness: TestDatabase;
  let issueDeviceToken: typeof import('../../src/auth/deviceToken.js').issueDeviceToken;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';
    ({ issueDeviceToken } = await import('../../src/auth/deviceToken.js'));
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  // cm:guard the assertion is that the OTHER issue is ABSENT, not merely that the wanted one is present. A filter core silently drops returns EVERY row, so an assertion that only looks for its own issue passes just as happily against no filtering at all — which is exactly how `complexity` reached all three projections and the strict schema with no way to filter on it.
  it('narrows to the asked-for complexity and leaves the others out', async () => {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'admin',
    });
    const { plaintext } = await issueDeviceToken({
      ownerId: user.id,
      name: 'd',
      platform: 'linux',
    });
    const ctx = await connectClientAsDevice(plaintext);
    try {
      const mk = async (complexity: string, title: string) => {
        const res = await ctx.client.callTool({
          name: 'forge_issues',
          arguments: {
            action: 'create',
            projectId: project.id,
            data: { title, status: 'draft', priority: 'low', complexity },
          },
        });
        return (parseToolResult(res as never) as { documentId: string }).documentId;
      };
      const small = await mk('xs', 'a tiny one');
      const large = await mk('xl', 'a huge one');

      const res = await ctx.client.callTool({
        name: 'forge_issues',
        arguments: { action: 'list', projectId: project.id, filters: { complexity: 'xs' } },
      });
      const listed = parseToolResult(res as never) as {
        issues: Array<{ documentId: string; complexity: string | null }>;
      };
      const ids = listed.issues.map((i) => i.documentId);
      expect(ids).toContain(small);
      expect(ids).not.toContain(large);
      expect(listed.issues.find((i) => i.documentId === small)?.complexity).toBe('xs');
    } finally {
      await ctx.close();
    }
  });
});
