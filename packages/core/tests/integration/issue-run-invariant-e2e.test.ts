/**
 * ISS-1050 criteria 30-32 — the inverse edge reports and moves nothing.
 *
 * This needs a real Postgres: the predicate is three `NOT EXISTS` clauses over
 * `jobs`, `pipeline_runs` and a `jsonb` containment on a run session's issue
 * group, and the containment is the half that has been silently wrong before
 * (ISS-992). A mocked db would assert the shape of a query rather than what it
 * selects, which is the only thing in question here.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let mods: {
  detectOrphanedRunAssertions: typeof import('../../src/pipeline/issue-run-invariant.js').detectOrphanedRunAssertions;
  openRunSession: typeof import('../../src/devices/run-session.js').openRunSession;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  const invariant = await import('../../src/pipeline/issue-run-invariant.js');
  const runSession = await import('../../src/devices/run-session.js');
  mods = {
    detectOrphanedRunAssertions: invariant.detectOrphanedRunAssertions,
    openRunSession: runSession.openRunSession,
  };
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

/** An issue at a status, last written `agoMs` ago. */
async function anIssueAt(args: {
  projectId: string;
  createdById: string;
  issSeq: number;
  status: string;
  agoMs: number;
}): Promise<string> {
  const written = new Date(Date.now() - args.agoMs).toISOString();
  const rows = (await harness.db.execute(sql`
    INSERT INTO issues (project_id, created_by_id, iss_seq, title, status, created_at, updated_at)
    VALUES (${args.projectId}, ${args.createdById}, ${args.issSeq}, ${`issue ${args.issSeq}`},
            ${args.status}, ${written}, ${written})
    RETURNING id
  `)) as unknown as { id: string }[];
  const id = rows[0]?.id;
  if (!id) throw new Error('anIssueAt: insert returned no row');
  return id;
}

async function statusOf(issueId: string): Promise<string> {
  const rows = (await harness.db.execute(
    sql`SELECT status FROM issues WHERE id = ${issueId}`,
  )) as unknown as { status: string }[];
  const status = rows[0]?.status;
  if (!status) throw new Error('statusOf: no such issue');
  return status;
}

const PAST_GRACE = 30 * 60 * 1000;

describe('an issue asserting work with no live run behind it', () => {
  it('is named once, and its status is not moved', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const issueId = await anIssueAt({
      projectId: project.id,
      createdById: user.id,
      issSeq: 1,
      status: 'in_progress',
      agoMs: PAST_GRACE,
    });

    const first = await mods.detectOrphanedRunAssertions();

    expect(first.detected, 'the predicate must match an assertion nothing is behind').toBe(1);
    expect(first.reported, 'the first sweep is the one that names the episode').toBe(1);
    expect(
      await statusOf(issueId),
      'retraction here would be a guess: an issue reaches in_progress by a baseline record a person wrote, not only by a run session',
    ).toBe('in_progress');

    const second = await mods.detectOrphanedRunAssertions();

    expect(second.detected, 'the disagreement has not gone away, so it still matches').toBe(1);
    expect(second.reported, 'but the episode is already named and is not named again').toBe(0);
  });

  it('says nothing about an issue a live run session is carrying', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const device = await createTestDevice(harness.db, user.id);
    await bindTestRunner(harness.db, { projectId: project.id, deviceId: device.id });
    await anIssueAt({
      projectId: project.id,
      createdById: user.id,
      issSeq: 7,
      status: 'in_progress',
      agoMs: PAST_GRACE,
    });
    await mods.openRunSession({
      deviceId: device.id,
      projectId: project.id,
      issueKeys: ['ISS-7'],
      name: 'run-a',
    });

    const result = await mods.detectOrphanedRunAssertions();

    expect(
      result.detected,
      'the run session names this issue in the canonical form; matching on the project prefix instead makes every live run invisible here (ISS-992)',
    ).toBe(0);
  });

  it('leaves alone an issue whose status was written a moment ago', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    await anIssueAt({
      projectId: project.id,
      createdById: user.id,
      issSeq: 2,
      status: 'in_progress',
      agoMs: 1000,
    });

    const result = await mods.detectOrphanedRunAssertions();

    expect(
      result.detected,
      'a dispatch writes the status and opens the run in two calls, so this predicate is briefly true of healthy work',
    ).toBe(0);
  });

  it('leaves alone an issue at a status that asserts no work', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    await anIssueAt({
      projectId: project.id,
      createdById: user.id,
      issSeq: 3,
      status: 'open',
      agoMs: PAST_GRACE,
    });

    const result = await mods.detectOrphanedRunAssertions();

    expect(
      result.detected,
      'an issue at a status no run puts it into says nothing by having no run behind it',
    ).toBe(0);
  });
});

/** A move into `status` at `at`, as the transition writes it. */
async function enteredAt(issueId: string, status: string, at: string): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, source, created_at)
    VALUES ('issue', ${issueId}, 'approved', ${status}, 'user', 'test', ${at})
  `);
}

/** A run over the issue that ended at `at`. */
async function runEndedAt(projectId: string, issueId: string, at: string): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (project_id, issue_id, kind, status, started_at, finished_at)
    VALUES (${projectId}, ${issueId}, 'issue', 'completed', ${at}, ${at})
  `);
}

async function noticeBodies(issueId: string): Promise<string[]> {
  const rows = (await harness.db.execute(
    sql`SELECT DISTINCT body FROM notifications WHERE issue_id = ${issueId}`,
  )) as unknown as { body: string }[];
  return rows.map((r) => r.body);
}

const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

// Judge j16 saw an orphan notice say "10 minutes" of an issue that had stood 14 (ISS-1229): it
// counted from the row's last write, and any write to the issue made the orphan read younger.
describe('how long an orphan notice says nothing has worked the issue', () => {
  it('counts from when its last run ended, not from a later write to the row', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const issueId = await anIssueAt({
      projectId: project.id,
      createdById: user.id,
      issSeq: 11,
      status: 'in_progress',
      agoMs: 5 * HOUR,
    });
    await enteredAt(issueId, 'in_progress', ago(4 * HOUR));
    await runEndedAt(project.id, issueId, ago(2 * HOUR + 60_000));
    await harness.db.execute(sql`UPDATE issues SET updated_at = ${ago(PAST_GRACE)} WHERE id = ${issueId}`);

    const result = await mods.detectOrphanedRunAssertions();

    expect(result.detected).toBe(1);
    expect(await noticeBodies(issueId)).toEqual([
      'ISS-11 reads In progress, and nothing has worked it for 2 hours: no job, issue run or run session is live for it.',
    ]);
  });

  it('counts from when the issue entered its status where no run ever worked it', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const issueId = await anIssueAt({
      projectId: project.id,
      createdById: user.id,
      issSeq: 12,
      status: 'in_progress',
      agoMs: 30 * HOUR,
    });
    await enteredAt(issueId, 'in_progress', ago(3 * HOUR + 60_000));
    await harness.db.execute(sql`UPDATE issues SET updated_at = ${ago(PAST_GRACE)} WHERE id = ${issueId}`);

    await mods.detectOrphanedRunAssertions();

    expect(await noticeBodies(issueId)).toEqual([
      'ISS-12 reads In progress, and nothing has worked it for 3 hours: no job, issue run or run session is live for it.',
    ]);
  });

  it('waits out the grace from the end of the last run, as it does from the status write', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const issueId = await anIssueAt({
      projectId: project.id,
      createdById: user.id,
      issSeq: 13,
      status: 'in_progress',
      agoMs: PAST_GRACE,
    });
    await runEndedAt(project.id, issueId, ago(60_000));

    const result = await mods.detectOrphanedRunAssertions();

    expect(result.detected, 'a run ended a minute ago is the race the grace exists for').toBe(0);
  });
});
