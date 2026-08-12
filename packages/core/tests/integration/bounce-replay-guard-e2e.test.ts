/**
 * ISS-820 — the `needs_info` release predicate (`isAi=false AND
 * author_device_id IS NULL`) is the security-relevant half of this issue: an
 * agent must not release its own bounce. The unit suite
 * (`src/pipeline/bounce-replay-guard.test.ts`) mocks the query builder and
 * ignores the `where` clause entirely, so it can't catch a regression to the
 * filter itself. This runs the real predicate against real Postgres.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('ISS-820 findUnansweredBounce — needs_info release requires a human comment', () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  });

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  const BOUNCED_AT = new Date('2026-08-01T10:00:00Z');

  async function seed() {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const device = await createTestDevice(harness.db, owner.id);
    const issueRows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO issues (project_id, title, status, created_by_id)
      VALUES (${project.id}, 'needs_info-bounce-target', 'needs_info', ${owner.id})
      RETURNING id
    `);
    const issueId = (issueRows[0] as { id: string }).id;

    await harness.db.execute(sql`
      INSERT INTO activity_log (issue_id, actor_type, actor_id, action, payload, created_at)
      VALUES (
        ${issueId}, 'device', ${device.id}, 'issue.statusChanged',
        ${JSON.stringify({ from: 'approved', to: 'needs_info' })}::jsonb,
        ${BOUNCED_AT.toISOString()}::timestamptz
      )
    `);

    return { owner, project, device, issueId };
  }

  async function insertComment(
    issueId: string,
    authorId: string,
    opts: { isAi: boolean; authorDeviceId: string | null; createdAt: Date },
  ) {
    await harness.db.execute(sql`
      INSERT INTO comments (issue_id, author_id, author_device_id, is_ai, body, created_at)
      VALUES (
        ${issueId}, ${authorId}, ${opts.authorDeviceId}, ${opts.isAi}, 'x',
        ${opts.createdAt.toISOString()}::timestamptz
      )
    `);
  }

  it('still blocks the replay when only an agent-authored comment landed since the bounce', async () => {
    const { owner, device, issueId } = await seed();
    await insertComment(issueId, owner.id, {
      isAi: true,
      authorDeviceId: device.id,
      createdAt: new Date('2026-08-01T11:00:00Z'),
    });

    const { findUnansweredBounce } = await import('../../src/pipeline/bounce-replay-guard.js');
    expect(await findUnansweredBounce(issueId, 'approved')).toEqual({
      bounced: 'needs_info',
      at: BOUNCED_AT,
    });
  });

  it('still blocks the replay when a PAT/MCP comment with isAi=true and no device landed since the bounce', async () => {
    const { owner, issueId } = await seed();
    await insertComment(issueId, owner.id, {
      isAi: true,
      authorDeviceId: null,
      createdAt: new Date('2026-08-01T11:00:00Z'),
    });

    const { findUnansweredBounce } = await import('../../src/pipeline/bounce-replay-guard.js');
    expect(await findUnansweredBounce(issueId, 'approved')).toEqual({
      bounced: 'needs_info',
      at: BOUNCED_AT,
    });
  });

  it('releases the replay when a human-authored comment (isAi=false, no device) landed since the bounce', async () => {
    const { owner, issueId } = await seed();
    await insertComment(issueId, owner.id, {
      isAi: false,
      authorDeviceId: null,
      createdAt: new Date('2026-08-01T11:00:00Z'),
    });

    const { findUnansweredBounce } = await import('../../src/pipeline/bounce-replay-guard.js');
    expect(await findUnansweredBounce(issueId, 'approved')).toBeNull();
  });
});
