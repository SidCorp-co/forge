/**
 * Every age a person reads for how long an issue has stood at its status counts from when it
 * entered that status, never from `updated_at` (ISS-1229 r8, judge-20): the Issues list read
 * "In progress 3m" six minutes after ISS-4 entered In progress, because a title edit three minutes
 * in had written the row. The issue list row, the Needs you items and the pulse's waiting ages are
 * each read here after exactly that edit.
 *
 * Real Postgres, because the claim is which column a subquery reads.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let owner: string;
let projectId: string;
let seq = 0;

const NOW = new Date();
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const ENTERED = minutesAgo(6);

describe('time in a status counts from entering it, not from the last write (real Postgres)', () => {
  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    seq = 0;
    owner = (await createTestUser(harness.db)).id;
    projectId = (await createTestProject(harness.db, owner)).id;
  });

  /** An issue created two days ago that moved into `status` six minutes ago and had its title
   *  edited three minutes ago, which is what writes `updated_at`. */
  async function editedAfterEntering(status: string): Promise<string> {
    seq += 1;
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, assignee_id,
                          created_at, updated_at)
      VALUES (${id}, ${projectId}, ${seq}, ${`ISS-${seq} renamed`}, ${status}, ${owner}, ${owner},
              ${minutesAgo(2 * 24 * 60).toISOString()}, ${minutesAgo(3).toISOString()})
    `);
    await harness.db.execute(sql`
      INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, source, created_at)
      VALUES ('issue', ${id}, 'approved', ${status}, 'user', 'test', ${ENTERED.toISOString()})
    `);
    return id;
  }

  it('gives an issue list row the time it entered its status', async () => {
    const id = await editedAfterEntering('in_progress');
    const { issueListPageQuery } = await import('../../src/issues/list-projection.js');
    const [row] = await issueListPageQuery({
      where: sql`issues.id = ${id}`,
      orderBy: sql`issues.created_at`,
      limit: 1,
      offset: 0,
    });
    expect(row?.statusEnteredAt.toISOString()).toBe(ENTERED.toISOString());
    expect(row?.updatedAt.toISOString()).toBe(minutesAgo(3).toISOString());
  });

  it('gives an issue that never moved the time it was created', async () => {
    seq += 1;
    const id = randomUUID();
    const created = minutesAgo(90);
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, created_at, updated_at)
      VALUES (${id}, ${projectId}, ${seq}, 'never moved', 'open', ${owner}, ${created.toISOString()}, now())
    `);
    const { issueListPageQuery } = await import('../../src/issues/list-projection.js');
    const [row] = await issueListPageQuery({
      where: sql`issues.id = ${id}`,
      orderBy: sql`issues.created_at`,
      limit: 1,
      offset: 0,
    });
    expect(row?.statusEnteredAt.toISOString()).toBe(created.toISOString());
  });

  it('dates a Needs you review item from when it entered its status', async () => {
    const id = await editedAfterEntering('developed');
    const { selectNeedsReview } = await import('../../src/me/attention-buckets.js');
    const [row] = await selectNeedsReview(owner);
    expect(row?.id).toBe(id);
    expect(row?.statusEnteredAt.toISOString()).toBe(ENTERED.toISOString());
  });

  it('dates a Needs you wait from the status where no question is open, and from the question where one is', async () => {
    const plain = await editedAfterEntering('needs_info');
    const asked = await editedAfterEntering('needs_info');
    const opened = minutesAgo(4);
    // The oldest open question to a person counts; a newer one, an answered older one and a
    // question only a machine can answer do not.
    const question = (status: string, kind: string, at: Date) => sql`
      INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps,
                                   claims_held, workspaces_pinned, dependents, created_at)
      VALUES (${randomUUID()}, ${projectId}, ${asked}, ${status}, ${kind}, '[]'::jsonb, 0, 0, 0,
              ${at.toISOString()})
    `;
    await harness.db.execute(question('open', 'human', opened));
    await harness.db.execute(question('open', 'human', minutesAgo(2)));
    await harness.db.execute(question('answered', 'human', minutesAgo(5)));
    await harness.db.execute(question('open', 'machine', minutesAgo(5)));
    const { selectAwaitingInput } = await import('../../src/me/attention-buckets.js');
    const rows = new Map((await selectAwaitingInput(owner)).map((r) => [r.id, r]));
    expect(rows.get(plain)?.waitingSince.toISOString()).toBe(ENTERED.toISOString());
    expect(rows.get(asked)?.waitingSince.toISOString()).toBe(opened.toISOString());
  });

  it('ages the pulse waiting figures from the status, not the edit', async () => {
    await editedAfterEntering('awaiting_release');
    await editedAfterEntering('in_progress');
    await editedAfterEntering('needs_info');
    const { readPulseWork } = await import('../../src/me/pulse-work.js');
    const work = await readPulseWork(
      [projectId],
      {
        abandonedIssueSeconds: 5 * 60,
        releaseWaitingSeconds: 5 * 60,
        projectSilenceSeconds: 86_400,
        silenceWarnSeconds: 3_600,
        silenceAlarmSeconds: 7_200,
        identityCap: 10,
      },
      NOW,
    );
    // Each stood at its status six minutes and was written three minutes ago: past a five-minute
    // threshold counted from entering it, short of one counted from the edit.
    expect(work.releaseWaiting.total).toBe(1);
    expect(work.releaseWaiting.shown[0]?.ageSeconds).toBe(360);
    expect(work.abandoned.total).toBe(1);
    expect(work.abandoned.shown[0]?.ageSeconds).toBe(360);
    expect(work.blockedOnPersonAges).toEqual([360]);
  });
});
