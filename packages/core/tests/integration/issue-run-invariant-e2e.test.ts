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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

// cm:why ISS-1063 — this file is about what the DETECTOR writes, not about the emission
// switch, and while the old notification surface is off the switch would suppress every
// type this file asserts. Mocking it here rather than relaxing the assertions keeps the
// detector's coverage intact for the whole of the silence; `src/notifications/emission-switch.test.ts`
// is what covers the switch itself, including that ops_alert is the one exception.
// cm:edge lockstep -> packages/core/src/notifications/emission-switch.ts — these mocks come out in the change that empties SUPPRESSED_TYPES; one left behind is a test asserting a surface nobody has turned back on
vi.mock('../../src/notifications/emission-switch.js', () => ({
  SUPPRESSED_TYPES: new Set<string>(),
  emissionAllowed: () => true,
  noteSuppressed: () => {},
}));

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

    // cm:guard the SECOND sweep is the assertion, not a repeat of the first. A warning repeated
    // every minute for the life of a disagreement is a warning nobody reads, which is the same
    // silence this pass exists to break (ISS-1050 criterion 32).
    const second = await mods.detectOrphanedRunAssertions();

    expect(second.detected, 'the disagreement has not gone away, so it still matches').toBe(1);
    expect(second.reported, 'but the episode is already named and is not named again').toBe(0);
  });

  it('says nothing about an issue a live run session is carrying', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const device = await createTestDevice(harness.db, user.id);
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
