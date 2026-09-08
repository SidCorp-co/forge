/**
 * A comment on an issue whose run is parked dispatches nothing — real Postgres.
 *
 * `deliverToPark` finds the session that asked by joining `jobs` →
 * `agent_sessions` and requiring `awaiting_input` on a non-terminal row. A
 * processless park matches on neither count: ISS-933 stopped minting a `drive`
 * job for a run session, and the process is gone by criterion 7. So the answer
 * fell through to `AUTONOMOUS_ENTRY_STATUS` and a second agent started on an
 * issue a first one was still waiting on (ISS-964 criterion 26).
 *
 * The machine case is the one that decides the ORDER: a machine park keeps its
 * process and has an open question row too, so a branch that read only "an open
 * question exists" would swallow the duplex send that works today.
 *
 * Real Postgres because the claim is which rows two joins keep and how many
 * `jobs` rows exist afterwards.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ws/broadcast.js', () => ({
  broadcast: vi.fn(),
  broadcastToProject: vi.fn(),
}));

import {
  createTestDevice,
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let ownerId: string;
let projectId: string;
let deviceId: string;
let issueId: string;
let seq = 0;

let answerReachesAParkedRun: typeof import('../../src/pipeline/answer-resume.js').answerReachesAParkedRun;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  ({ answerReachesAParkedRun } = await import('../../src/pipeline/answer-resume.js'));
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  seq = 0;
  ownerId = (await createTestUser(harness.db)).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  deviceId = (await createTestDevice(harness.db, ownerId, { name: 'park-box' })).id;
  seq += 1;
  issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, ${seq}, 'parked', 'needs_info', ${ownerId})
  `);
});

async function question(opts: {
  blockerKind: 'human' | 'machine' | 'master_or_peer';
  status?: 'open' | 'answered' | 'void' | 'expired';
  withWaiter?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_questions
      (id, project_id, issue_id, status, blocker_kind, steps)
    VALUES (${id}, ${projectId}, ${issueId}, ${opts.status ?? 'open'}, ${opts.blockerKind},
            '[]'::jsonb)
  `);
  if (opts.withWaiter !== false) {
    await harness.db.execute(sql`
      INSERT INTO question_waiters (id, question_id, device_id, run_id)
      VALUES (${randomUUID()}, ${id}, ${deviceId}, ${`run-${id.slice(0, 8)}`})
    `);
  }
  return id;
}

describe('an answer owed to a parked run', () => {
  // cm:guard the branch is what stops the dispatch, so this asserts the DECISION rather than the job count — the count is asserted by `answer-resume` end to end, and a helper returning true while the caller ignores it would pass a job-count assertion here for the wrong reason.
  it('is recognised when a human park is waiting on this issue', async () => {
    await question({ blockerKind: 'human' });
    expect(await answerReachesAParkedRun(issueId)).toBe(true);
  });

  // cm:guard THE ordering case. A machine park keeps its process and carries an open question too, so a branch keyed on "an open question exists" would claim this one and silence the duplex send that works today — `deliverToPark` must stay the path for it.
  it('is not claimed for a machine park, which still holds its process', async () => {
    await question({ blockerKind: 'machine' });
    expect(await answerReachesAParkedRun(issueId)).toBe(false);
  });

  it('is not claimed for a master-or-peer park either', async () => {
    await question({ blockerKind: 'master_or_peer' });
    expect(await answerReachesAParkedRun(issueId)).toBe(false);
  });

  // cm:guard no waiter means no box is coming back for this answer, so claiming it would park the issue forever with nothing on the other end. The waiter row IS the evidence that a run is waiting.
  it('is not claimed when no run registered as a waiter', async () => {
    await question({ blockerKind: 'human', withWaiter: false });
    expect(await answerReachesAParkedRun(issueId)).toBe(false);
  });

  it.each(['answered', 'void', 'expired'] as const)(
    'is not claimed once the question is %s',
    async (status) => {
      await question({ blockerKind: 'human', status });
      expect(await answerReachesAParkedRun(issueId)).toBe(false);
    },
  );

  it('is not claimed on an issue with no question at all', async () => {
    expect(await answerReachesAParkedRun(issueId)).toBe(false);
  });

  // cm:guard scoped to THIS issue. A park open on another issue must not silence the answer on this one, which is the failure a query missing the issue predicate produces on any project with two parks.
  it('is not claimed by a park open on a different issue', async () => {
    const other = randomUUID();
    seq += 1;
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${other}, ${projectId}, ${seq}, 'elsewhere', 'needs_info', ${ownerId})
    `);
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps)
      VALUES (${id}, ${projectId}, ${other}, 'open', 'human', '[]'::jsonb)
    `);
    await harness.db.execute(sql`
      INSERT INTO question_waiters (id, question_id, device_id, run_id)
      VALUES (${randomUUID()}, ${id}, ${deviceId}, 'run-other')
    `);

    expect(await answerReachesAParkedRun(issueId)).toBe(false);
  });
});

describe('the whole episode: a person comments while a run is parked', () => {
  async function autonomous(): Promise<void> {
    await harness.db.execute(sql`
      UPDATE projects SET agent_config = ${JSON.stringify({ pipelineConfig: { enabled: true } })}::jsonb
      WHERE id = ${projectId}
    `);
  }

  async function comment(): Promise<void> {
    const { HooksBus } = await import('../../src/pipeline/hooks.js');
    const { registerAnswerResume } = await import('../../src/pipeline/answer-resume.js');
    const bus = new HooksBus();
    registerAnswerResume(bus);
    await bus.emit('commentCreated', {
      issueId,
      projectId,
      actor: { type: 'user', id: ownerId, agency: 'human' },
      commentId: randomUUID(),
      body: 'go with the second one',
    });
  }

  async function counts(): Promise<{ status: string; jobs: number }> {
    const [i] = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM issues WHERE id = ${issueId}`,
    );
    const [j] = await harness.db.execute<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM jobs WHERE issue_id = ${issueId}`,
    );
    return { status: i?.status ?? 'gone', jobs: j?.n ?? -1 };
  }

  // cm:guard criterion 26's own assertion, and the reason the branch exists: the issue must NOT leave `needs_info`, because the transition is what the orchestrator hook dispatches on. Zero jobs is asserted rather than derived — a branch that returned early but still transitioned would leave this issue `open` with the dispatch one hook away.
  it('dispatches nothing and leaves the issue parked', async () => {
    await autonomous();
    await question({ blockerKind: 'human' });

    await comment();

    expect(await counts()).toEqual({ status: 'needs_info', jobs: 0 });
  });

  // cm:guard the fallback is NOT removed, only preceded. An issue at the question status with no park open is the print-mode episode the fallback was written for, and it must still go back to the driver.
  it('still returns an issue with no park open to the driver', async () => {
    await autonomous();

    await comment();

    expect((await counts()).status).toBe('open');
  });
});
