/**
 * ISS-1237 — the readers of `issues` that the reader gate classified as discovery, outside the
 * plan's first inventory. Each case holds an archived issue and a live control that differ only in
 * `archived_at`, so a read that ignores the column answers both and goes red.
 *
 * Beside them, the nightly consolidation, which reads no memory of an archived issue into its
 * prompt; and the one caller the archive guard reaches that must answer rather than throw: a
 * Sentry regression on an archived closed issue is refused by name, like one on a dropped issue.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { type Env, Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const llm = vi.hoisted(() => ({ prompts: [] as string[] }));
vi.mock('../../src/memory/llm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/memory/llm.js')>()),
  fastModelConfigured: () => true,
  callFastModel: async (prompt: string) => {
    llm.prompts.push(prompt);
    return '{"create":[],"update":[],"archive":[]}';
  },
}));

let harness: TestDatabase;
let projectId: string;
let userId: string;
let token: string;

async function seed(seq: number, status: string, extra: { externalId?: string } = {}) {
  const id = randomUUID();
  const merged = status === 'closed' ? sql`now()` : sql`NULL`;
  const source = extra.externalId ? 'sentry' : 'manual';
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at,
                        source, external_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${userId}, ${merged},
            ${source}, ${extra.externalId ?? null})`);
  return id;
}

async function archive(keys: string[]) {
  const { runIssueArchive } = await import('../../src/issues/archive.js');
  await runIssueArchive({
    projectId,
    direction: 'archive',
    filter: { keys },
    dryRun: false,
    actor: { type: 'user', id: userId, agency: 'human' },
  });
}

async function get<E extends Env>(path: string, routes: Hono<E>, mount: string) {
  const app = new Hono<E>().route(mount, routes);
  const res = await app.request(path, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return res.json();
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.EMBEDDINGS_BASE_URL ??= 'http://embeddings.invalid';
  process.env.EMBEDDINGS_API_KEY ??= 'test-key';
}, 180_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  userId = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  projectId = (await createTestProject(harness.db, userId)).id;
  await createTestProjectMember(harness.db, { userId, projectId, role: 'admin' });
  const { signUserToken } = await import('../../src/auth/jwt.js');
  token = await signUserToken(userId);
});

describe('the discovery reads outside the plan inventory', () => {
  it('leaves an archived issue out of recent changes, however recently it moved', async () => {
    await seed(1, 'closed');
    await seed(2, 'closed');
    await archive(['ISS-1']);
    const { meRecentChangesRoutes } = await import('../../src/me/recent-changes-routes.js');
    const body = (await get('/api/me/recent-changes', meRecentChangesRoutes, '/api/me')) as {
      items: { issSeq: number }[];
    };
    expect(body.items.map((i) => i.issSeq)).toEqual([2]);
  });

  it('leaves an archived issue out of a module edge, and its count', async () => {
    const [a, b] = await Promise.all([seed(1, 'closed'), seed(2, 'closed')]);
    const [m1, m2] = [randomUUID(), randomUUID()];
    await harness.db.execute(sql`
      INSERT INTO labels (id, project_id, name, color, kind, slug)
      VALUES (${m1}, ${projectId}, 'm1', '#000', 'module', 'm1'),
             (${m2}, ${projectId}, 'm2', '#000', 'module', 'm2')`);
    for (const issue of [a, b]) {
      await harness.db.execute(sql`
        INSERT INTO issue_labels (issue_id, label_id) VALUES (${issue}, ${m1}), (${issue}, ${m2})`);
    }
    const { observedModuleEdges } = await import('../../src/labels/module-drift.js');
    const edges = async () =>
      (await observedModuleEdges(projectId)).map((e) => [e.issueCount, e.recentIssueSeqs]);
    expect(await edges()).toEqual([[2, [2, 1]]]);
    await archive(['ISS-1']);
    expect(await edges()).toEqual([[1, [2]]]);
  });

  it('leaves an archived issue out of the project activity feed', async () => {
    const archived = await seed(1, 'closed');
    const live = await seed(2, 'closed');
    for (const issue of [archived, live]) {
      await harness.db.execute(sql`
        INSERT INTO activity_log (issue_id, actor_type, actor_id, action)
        VALUES (${issue}, 'user', ${userId}, 'issue.commented')`);
    }
    await archive(['ISS-1']);
    const { projectActivityRoutes } = await import('../../src/issues/activity-routes.js');
    const body = (await get(
      `/api/projects/${projectId}/activity`,
      projectActivityRoutes,
      '/api/projects',
    )) as { items: { issueId: string }[] };
    expect(new Set(body.items.map((i) => i.issueId))).toEqual(new Set([live]));
  });

  it("leaves an archived issue out of attention's mentions and failed jobs", async () => {
    const ids = { archived: await seed(1, 'dropped'), live: await seed(2, 'dropped') };
    for (const issue of Object.values(ids)) {
      const comment = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO comments (id, issue_id, author_id, body) VALUES (${comment}, ${issue}, ${userId}, 'hi')`);
      await harness.db.execute(sql`
        INSERT INTO comment_mentions (comment_id, user_id) VALUES (${comment}, ${userId})`);
      const run = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
        VALUES (${run}, ${projectId}, ${issue}, 'issue', 'failed', now())`);
      await harness.db.execute(sql`
        INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, created_by, queued_at)
        VALUES (${randomUUID()}, ${projectId}, ${issue}, ${run}, 'drive', 'failed', ${userId}, now())`);
    }
    await archive(['ISS-1']);
    const buckets = await import('../../src/me/attention-buckets.js');
    expect((await buckets.selectMentions(userId)).map((r) => r.issSeq)).toEqual([2]);
    expect((await buckets.selectFailedJobs(userId)).map((r) => r.issSeq)).toEqual([2]);
  });
});

describe('the nightly consolidation', () => {
  it('reads no fact extracted from an archived issue, and keeps one from a live issue', async () => {
    const archived = await seed(1, 'closed');
    const live = await seed(2, 'closed');
    await harness.db.execute(sql`
      INSERT INTO comments (issue_id, author_id, body) VALUES (${live}, ${userId}, 'recent signal')`);
    for (const [ref, issueId] of [
      ['fact:archived', archived],
      ['fact:live', live],
    ]) {
      await harness.db.execute(sql`
        INSERT INTO memories (project_id, source, source_ref, text_content, metadata)
        VALUES (${projectId}, 'knowledge', ${ref}, ${`the text of ${ref}`},
                ${JSON.stringify({ issueId })}::jsonb)`);
    }
    await archive(['ISS-1']);
    llm.prompts.length = 0;
    const { runConsolidationForProject } = await import('../../src/memory/consolidation.js');
    await runConsolidationForProject(projectId);
    expect(llm.prompts).toHaveLength(1);
    expect(llm.prompts[0]).toContain('the text of fact:live');
    expect(llm.prompts[0]).not.toContain('the text of fact:archived');
  });
});

describe('a Sentry regression on an archived closed issue', () => {
  it('is refused by name, and the issue stays closed and archived', async () => {
    const id = await seed(1, 'closed', { externalId: 'PROJ-1' });
    await archive(['ISS-1']);
    const { intakeSentryIssue, readSentryThresholds } = await import(
      '../../src/integrations/sentry/intake-issue.js'
    );
    const outcome = await intakeSentryIssue(
      {
        id: 's1',
        shortId: 'PROJ-1',
        status: 'unresolved',
        substatus: 'regressed',
        level: 'error',
        count: 10,
        userCount: 1,
        firstSeen: '2026-09-01T00:00:00Z',
        lastSeen: '2026-09-24T00:00:00Z',
        permalink: null,
        projectSlug: 'proj',
        title: 'boom',
        culprit: null,
        metadataValue: null,
      },
      {
        projectId,
        createdById: userId,
        thresholds: await readSentryThresholds(),
        target: { label: 'proj', organizationSlug: 'org' },
      },
    );
    expect(outcome).toEqual({
      kind: 'refused',
      reason: expect.stringContaining('ISS-1 is archived'),
    });
    const [row] = (await harness.db.execute(
      sql`SELECT status, archived_at IS NOT NULL AS archived FROM issues WHERE id = ${id}`,
    )) as unknown as { status: string; archived: boolean }[];
    expect(row).toEqual({ status: 'closed', archived: true });
  });
});
