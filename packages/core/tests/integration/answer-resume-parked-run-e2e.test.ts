/**
 * Whether a box is coming back for this answer — real Postgres.
 *
 * This is the code behind the `answer-resume-park` protection core advertises
 * at `GET /me/protections`, and a box releases its process on that
 * advertisement. If it answered wrongly in the false direction, core would
 * dispatch a second agent onto a worktree the first still holds; in the true
 * direction the issue would sit at the question status with nobody coming.
 *
 * It replaced a predicate keyed on the ISSUE carrying an open question, which
 * cannot serve the answer path: by the time an answer is being resumed the
 * question is `answered` by construction, so that predicate read false for
 * every question a box was waiting on.
 *
 * Real Postgres because the claim is which rows a join keeps.
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

let aBoxWillReadThisAnswer: typeof import('../../src/pipeline/answer-resume.js').aBoxWillReadThisAnswer;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  ({ aBoxWillReadThisAnswer } = await import('../../src/pipeline/answer-resume.js'));
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  deviceId = (await createTestDevice(harness.db, ownerId, { name: 'park-box' })).id;
  issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 1, 'parked', 'needs_info', ${ownerId})
  `);
});

async function question(opts: {
  status?: 'open' | 'answered' | 'void' | 'expired';
  withWaiter?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps)
    VALUES (${id}, ${projectId}, ${issueId}, ${opts.status ?? 'answered'}, 'human', '[]'::jsonb)
  `);
  if (opts.withWaiter !== false) {
    await harness.db.execute(sql`
      INSERT INTO question_waiters (id, question_id, device_id, run_id)
      VALUES (${randomUUID()}, ${id}, ${deviceId}, ${`run-${id.slice(0, 8)}`})
    `);
  }
  return id;
}

describe('an answer a box will come back for', () => {
  it('is recognised by the waiter the box registered', async () => {
    expect(await aBoxWillReadThisAnswer(await question({}))).toBe(true);
  });

  // cm:guard no waiter means nothing is coming back for this answer, and core must dispatch rather than leave the issue parked forever. A park mints its question inside the transition and registers no waiter, which is now the COMMON case rather than the exotic one.
  it('is not recognised when no run registered for it', async () => {
    expect(await aBoxWillReadThisAnswer(await question({ withWaiter: false }))).toBe(false);
  });

  // cm:guard the question's own STATUS is deliberately not read: the answer path runs after the row is `answered`, so a status filter here would answer false for every question a box is actually waiting on — the exact failure that retired the predicate this replaced.
  it.each(['open', 'answered'] as const)(
    'reads the waiter whatever the question status says (%s)',
    async (status) => {
      expect(await aBoxWillReadThisAnswer(await question({ status }))).toBe(true);
    },
  );

  it('is not recognised for a question that does not exist', async () => {
    expect(await aBoxWillReadThisAnswer(randomUUID())).toBe(false);
  });
});
