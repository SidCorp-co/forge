/**
 * ISS-1421 — what an intake files, Forge files.
 *
 * A Sentry error with its sightings and reopen, a GitHub issue taken in, and a knowledge promotion
 * are each driven once against real Postgres and read back for who the row names.
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

let harness: TestDatabase;
let FORGE: string;
let projectId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  FORGE = (await import('../../src/comments/forge-author.js')).FORGE_AUTHOR_ID;
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const ownerId = (await createTestUser(harness.db)).id;
  projectId = (await createTestProject(harness.db, ownerId)).id;
});

async function authorsOn(issueId: string): Promise<string[]> {
  const rows = await harness.db.execute<{ author_id: string }>(
    sql`SELECT author_id FROM comments WHERE issue_id = ${issueId} ORDER BY created_at, id`,
  );
  return rows.map((r) => r.author_id);
}

async function moversOf(
  issueId: string,
): Promise<Array<{ actor_id: string; actor_agency: string }>> {
  return harness.db.execute<{ actor_id: string; actor_agency: string }>(sql`
    SELECT actor_id, actor_agency FROM kernel_transitions
    WHERE entity = 'issue' AND entity_id = ${issueId} ORDER BY created_at
  `);
}

describe('what an intake files is filed by Forge (ISS-1421)', () => {
  const sentryIssue = (over: Record<string, unknown> = {}) => ({
    id: 's1',
    shortId: 'PROJ-1',
    status: 'unresolved',
    substatus: null,
    level: 'error',
    count: 50,
    userCount: 5,
    firstSeen: '2026-09-01T00:00:00Z',
    lastSeen: '2026-09-24T00:00:00Z',
    permalink: null,
    projectSlug: 'proj',
    title: 'boom',
    culprit: null,
    metadataValue: null,
    ...over,
  });

  it('files a Sentry error, notes a sighting and reopens a regression, each as Forge', async () => {
    const { intakeSentryIssue } = await import('../../src/integrations/sentry/intake-issue.js');
    const ctx = {
      projectId,
      thresholds: { minEventCount: 1, minUserCount: 1 },
      target: { label: 'proj', organizationSlug: 'org' },
    };
    expect(await intakeSentryIssue(sentryIssue(), ctx)).toEqual({ kind: 'filed' });
    const [filed] = await harness.db.execute<{ id: string; created_by_id: string }>(sql`
      SELECT id, created_by_id FROM issues WHERE project_id = ${projectId} AND source = 'sentry'
    `);
    expect(filed?.created_by_id).toBe(FORGE);
    const id = filed?.id as string;

    expect(await intakeSentryIssue(sentryIssue({ count: 80 }), ctx)).toEqual({ kind: 'commented' });
    expect(await authorsOn(id)).toEqual([FORGE]);

    await harness.db.execute(
      sql`UPDATE issues SET status = 'closed', merged_at = now() WHERE id = ${id}`,
    );
    const regressed = sentryIssue({
      count: 90,
      substatus: 'regressed',
      lastSeen: '2026-09-30T00:00:00Z',
    });
    expect(await intakeSentryIssue(regressed, ctx)).toEqual({ kind: 'reopened' });
    expect(await moversOf(id)).toEqual([{ actor_id: FORGE, actor_agency: 'agent' }]);
    expect(new Set(await authorsOn(id))).toEqual(new Set([FORGE]));
  });

  it('takes a GitHub issue in as Forge', async () => {
    await harness.db.execute(sql`
      UPDATE projects SET agent_config = ${JSON.stringify({
        pipelineConfig: { githubIntake: { enabled: true } },
      })}::jsonb WHERE id = ${projectId}
    `);
    const { handleGitHubEvent } = await import('../../src/webhooks/github-adapter.js');
    await handleGitHubEvent({ projectId } as Parameters<typeof handleGitHubEvent>[0], 'issues', {
      action: 'opened',
      issue: { id: 77, title: 'from GitHub', body: null },
    });
    const rows = await harness.db.execute<{ created_by_id: string }>(sql`
      SELECT created_by_id FROM issues WHERE project_id = ${projectId} AND source = 'github'
    `);
    expect(rows.map((r) => r.created_by_id)).toEqual([FORGE]);
  });

  it('proposes a knowledge promotion as Forge', async () => {
    await harness.db.execute(sql`
      UPDATE projects SET agent_config = ${JSON.stringify({
        pipelineConfig: { knowledgePromotion: { enabled: true, minRetrievals: 1 } },
      })}::jsonb WHERE id = ${projectId}
    `);
    await harness.db.execute(sql`
      INSERT INTO memories (project_id, source, source_ref, text_content, retrieval_count, created_at)
      VALUES (${projectId}, 'decision', 'dec-1', 'a lesson', 9, now() - interval '60 days')
    `);
    const { proposeKnowledgePromotions } = await import('../../src/memory/knowledge-promotion.js');
    await proposeKnowledgePromotions(projectId);
    const rows = await harness.db.execute<{ created_by_id: string }>(sql`
      SELECT created_by_id FROM issues WHERE project_id = ${projectId}
        AND category = 'knowledge-promotion'
    `);
    expect(rows.map((r) => r.created_by_id)).toEqual([FORGE]);
  });
});
