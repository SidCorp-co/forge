/**
 * ISS-1229 r15 — judge-38's readings of the attention read, each planted against the round-14 route
 * and seen red before the fix:
 *
 * - Needs you counts every item its list holds, listed or not: the reader's parks split by whether a
 *   question is open, and the stuck issues none of its other counts holds, each issue once.
 * - A parked issue a stuck-issue notice stands for carries that notice's reason, in the attention read
 *   and in the health row's parked list, so a screen tells it by its notice.
 * - A failed job's failure is its stored cause code, never the classifier's sentence.
 * - Nothing of an archived project is counted or listed: its page answers not found.
 */

import { randomUUID } from 'node:crypto';
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

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let viewer: string;
let projectId: string;
let slug: string;
let seq = 0;

beforeEach(async () => {
  await truncateAll(harness.db);
  seq = 0;
  viewer = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${viewer}`);
  const project = await createTestProject(harness.db, viewer);
  projectId = project.id;
  slug = project.slug;
  await createTestProjectMember(harness.db, { userId: viewer, projectId, role: 'admin' });
});

async function issueAt(
  status: string,
  opts: { question?: boolean; assignee?: string | null; project?: string } = {},
): Promise<string> {
  seq += 1;
  const id = randomUUID();
  const project = opts.project ?? projectId;
  const assignee = opts.assignee === undefined ? viewer : opts.assignee;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, assignee_id,
                        created_at, updated_at)
    VALUES (${id}, ${project}, ${seq}, ${`ISS-${seq} at ${status}`}, ${status}, ${viewer},
            ${assignee}, now(), now())
  `);
  if (opts.question) {
    await harness.db.execute(sql`
      INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps,
                                   claims_held, workspaces_pinned, dependents)
      VALUES (${randomUUID()}, ${project}, ${id}, 'open', 'human', '[]'::jsonb, 0, 0, 0)
    `);
  }
  return id;
}

/** A stuck-issue notice standing for the issue, under the resolution-key suffix its sweep writes. */
async function stuck(issueId: string, suffix: string, project = projectId): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO notifications (project_id, issue_id, type, kind, tier, state, title, resolution_key)
    VALUES (${project}, ${issueId}, 'issue_stranded', 'condition', 'ticket', 'firing', 'stuck',
            ${`issue:${issueId}${suffix}`})
  `);
}

async function failedJob(
  over: {
    issueId?: string;
    error?: string | null;
    failureReason?: string | null;
    project?: string;
    minutesAgo?: number;
  } = {},
): Promise<void> {
  const runId = randomUUID();
  const project = over.project ?? projectId;
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
    VALUES (${runId}, ${project}, 'system', 'failed', now())
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, issue_id, type, status, created_by,
                      created_at, error, failure_reason)
    VALUES (${randomUUID()}, ${project}, ${runId}, ${over.issueId ?? null}, 'drive', 'failed',
            ${viewer}, now() - make_interval(mins => ${over.minutesAgo ?? 0}), ${over.error ?? null},
            ${over.failureReason ?? null})
  `);
}

async function get<T>(path: string): Promise<T> {
  const res = await app.request(path, {
    headers: { authorization: `Bearer ${await signUserToken(viewer)}` },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
}

type Item = {
  issueRef?: string;
  stuckKind?: string;
  failure?: string | null;
  failedJob?: { jobType: string; failure: string | null };
};
type Attention = {
  needsReview: Item[];
  awaitingInput: Item[];
  failedJobs: Item[];
  projectTotals: Record<string, Record<string, number>>;
  bucketTotals: Record<string, number>;
  total: number;
};
type Health = Array<{
  projectSlug: string;
  stuckIssues: number;
  stuckIssuesByKind: Record<string, number>;
  stuckIssueRefs: Array<{ issueId: string }>;
  blockers: Array<{ issueId: string; stuckKind?: string }>;
}>;

describe("Needs you's whole, on judge-38's shape of board", () => {
  it('counts the parks the reader owes by question, and every stuck issue once', async () => {
    // Two of the reader's own Waiting parks, filed by them and assigned to nobody, both stuck; and
    // one park with a question open that is not stuck.
    const parkA = await issueAt('waiting', { assignee: null });
    const parkB = await issueAt('waiting', { assignee: null });
    await issueAt('needs_info', { question: true });
    await stuck(parkA, ':stranded');
    await stuck(parkB, ':stranded');
    // Three Open issues nothing works, and an In progress one with no run that is idle as well.
    for (let i = 0; i < 3; i++) await stuck(await issueAt('open'), ':idle');
    const orphan = await issueAt('in_progress');
    await stuck(orphan, ':idle');
    await stuck(orphan, ':run-assertion-orphaned');

    const attention = await get<Attention>('/api/me/attention');
    const health = await get<Health>('/api/projects/health');
    const row = health.find((h) => h.projectSlug === slug);

    expect(attention.projectTotals[slug]).toEqual({
      needsReview: 0,
      awaitingInput: 3,
      awaitingAsked: 1,
      failedJobs: 0,
      parkedOnly: 0,
      parkedAsked: 0,
      stuckOnly: 4,
    });
    // The two stuck parks are counted in `awaitingInput`, the four others in `stuckOnly`: the 6.
    expect(row?.stuckIssues).toBe(6);
    expect(attention.awaitingInput.map((i) => i.stuckKind ?? 'none').sort()).toEqual([
      'none',
      'waiting',
      'waiting',
    ]);
    expect(row?.blockers.map((b) => b.stuckKind ?? 'none').sort()).toEqual([
      'none',
      'waiting',
      'waiting',
    ]);
  });

  it("counts another person's park that holds a question as asked, apart from the parks with none", async () => {
    const other = (await createTestUser(harness.db)).id;
    await stuck(await issueAt('needs_info', { question: true, assignee: other }), ':stranded');
    await stuck(await issueAt('on_hold', { assignee: other }), ':stranded');
    // A park no notice stands for is its owner's alone, not the reader's (ISS-1229 r17, judge-44).
    await issueAt('needs_info', { question: true, assignee: other });

    const attention = await get<Attention>('/api/me/attention');
    expect(attention.projectTotals[slug]).toMatchObject({ parkedOnly: 2, parkedAsked: 1 });
  });

  it('counts a stuck issue a failed job of the reader names once, as the failed job', async () => {
    const issue = await issueAt('open');
    await stuck(issue, ':idle');
    await failedJob({ issueId: issue, error: 'session_lost' });

    const attention = await get<Attention>('/api/me/attention');
    expect(attention.projectTotals[slug]).toMatchObject({
      failedJobs: 1,
      parkedAsked: 0,
      stuckOnly: 0,
    });
    expect(attention.failedJobs[0]?.stuckKind).toBe('idle');
  });
});

describe('a failed job, said by its stored cause', () => {
  it.each([
    [
      "the job's code where the classifier wrote a sentence",
      {
        failureReason:
          'agent session terminated without job completion (silent runner/agent death)',
        error: 'session_lost',
      },
      'session_lost',
    ],
    [
      "the classifier's code where it wrote one",
      { failureReason: 'heartbeat_timeout', error: 'Process exited 1' },
      'heartbeat_timeout',
    ],
    ['no cause where neither is a code', { failureReason: 'it broke', error: 'Exit 1' }, null],
  ] as const)('carries %s', async (_name, written, failure) => {
    await failedJob(written);
    const attention = await get<Attention>('/api/me/attention');
    expect(attention.failedJobs).toHaveLength(1);
    expect(attention.failedJobs[0]?.failure).toBe(failure);
  });
});

describe('an archived project, in the attention read', () => {
  it('neither counts nor lists its parks, failed jobs or stuck issues, anywhere the read is summed', async () => {
    const archived = await createTestProject(harness.db, viewer);
    await createTestProjectMember(harness.db, {
      userId: viewer,
      projectId: archived.id,
      role: 'admin',
    });
    const park = await issueAt('needs_info', { project: archived.id });
    await stuck(park, ':stranded', archived.id);
    await stuck(await issueAt('open', { project: archived.id }), ':idle', archived.id);
    await failedJob({ project: archived.id, error: 'session_lost' });
    await harness.db.execute(
      sql`UPDATE projects SET archived_at = now() WHERE id = ${archived.id}`,
    );
    // One live park beside it, which stays.
    await issueAt('needs_info');

    const attention = await get<Attention>('/api/me/attention');
    expect(attention.awaitingInput).toHaveLength(1);
    expect(attention.failedJobs).toHaveLength(0);
    expect(attention.bucketTotals).toMatchObject({ awaitingInput: 1, failedJobs: 0 });
    expect(attention.total).toBe(1);
    expect(Object.keys(attention.projectTotals)).toEqual([slug]);
  });
});

// ISS-1229 r15, the master's ruling on the round's hand-back: ISS-15 was the failed job on Needs you
// and also one of the "8 issues in a live status with no live work" and a NO LIVE WORK bell row. One
// issue is one row, counted once: an answer the reader owes > a failed job > a stuck reason.
describe('one issue, one row, counted once', () => {
  const stuckIssuesListed = async () =>
    (await get<{ total: number }>(`/api/projects/${projectId}/issues/search?stuck=true`)).total;

  it('counts a failed and stuck issue once, as the failed job, by its latest failure', async () => {
    const failed = await issueAt('open');
    await stuck(failed, ':idle');
    await failedJob({ issueId: failed, error: 'heartbeat_timeout', minutesAgo: 30 });
    await failedJob({ issueId: failed, error: 'session_lost' });
    // Beside it, a stuck issue no failure names, which stays stuck.
    await stuck(await issueAt('open'), ':idle');

    const attention = await get<Attention>('/api/me/attention');
    const health = await get<Health>('/api/projects/health');
    const row = health.find((h) => h.projectSlug === slug);

    expect(attention.failedJobs.map((j) => [j.failure, j.stuckKind])).toEqual([
      ['session_lost', 'idle'],
    ]);
    expect(attention.bucketTotals.failedJobs).toBe(1);
    expect(attention.projectTotals[slug]).toMatchObject({ failedJobs: 1, stuckOnly: 1 });
    expect(attention.total).toBe(1);
    expect(row?.stuckIssues).toBe(1);
    expect(row?.stuckIssuesByKind).toEqual({ idle: 1 });
    expect(row?.stuckIssueRefs).toHaveLength(1);
    expect(await stuckIssuesListed()).toBe(1);
  });

  it('lists an issue owed an answer and holding a failed job once, as the answer, naming the failure', async () => {
    const asked = await issueAt('needs_info', { question: true });
    await failedJob({ issueId: asked, error: 'session_lost' });
    const review = await issueAt('developed');
    await failedJob({ issueId: review, failureReason: 'heartbeat_timeout' });

    const attention = await get<Attention>('/api/me/attention');

    expect(attention.failedJobs).toEqual([]);
    expect(attention.bucketTotals).toMatchObject({
      awaitingInput: 1,
      needsReview: 1,
      failedJobs: 0,
    });
    expect(attention.projectTotals[slug]).toMatchObject({
      awaitingInput: 1,
      needsReview: 1,
      failedJobs: 0,
    });
    expect(attention.total).toBe(2);
    expect(attention.awaitingInput[0]?.failedJob).toEqual({
      jobType: 'drive',
      failure: 'session_lost',
    });
    expect(attention.needsReview[0]?.failedJob).toEqual({
      jobType: 'drive',
      failure: 'heartbeat_timeout',
    });
  });

  it('keeps counting as stuck an issue whose failed job is listed under the answer it is owed', async () => {
    const park = await issueAt('waiting', { assignee: null });
    await stuck(park, ':stranded');
    await failedJob({ issueId: park, error: 'session_lost' });

    const attention = await get<Attention>('/api/me/attention');
    const row = (await get<Health>('/api/projects/health')).find((h) => h.projectSlug === slug);

    expect(attention.failedJobs).toEqual([]);
    expect(attention.awaitingInput[0]?.failedJob?.failure).toBe('session_lost');
    expect(row?.stuckIssues).toBe(1);
    expect(await stuckIssuesListed()).toBe(1);
  });
});
