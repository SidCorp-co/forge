/**
 * The release-record refusal against real Postgres.
 *
 * The unit suite mocks `db`, so it can prove the branch logic and nothing
 * about the transaction the branch runs before. That distinction is not
 * theoretical here: the first version of this rule also required
 * `merged_at IS NULL`, passed the mocked suite, and was falsified by this
 * layer — `markMergedIfLeavingBase` stamps inside the same transaction the
 * check reads the column before, so the condition refused the one path it
 * was written to exempt.
 *
 * So the assertions below are about what the DATABASE holds afterwards, not
 * about which branch was taken: a refused close leaves the row untouched and
 * `merged_at` unstamped, and the exempt paths reach `closed` for real.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type IssueRow = { id: string; projectId: string; status: string; reopenCount: number };

describe('release record required E2E', () => {
  let harness: TestDatabase;
  let projectId: string;
  let ownerId: string;
  let seq = 0;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.NODE_ENV ??= 'test';
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    projectId = (await createTestProject(harness.db, owner.id)).id;
  });

  async function insertIssue(status: string, note: unknown = null): Promise<string> {
    const id = randomUUID();
    seq += 1;
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes)
      VALUES (
        ${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId},
        ${note === null ? null : JSON.stringify(note)}::jsonb
      )
    `);
    return id;
  }

  // cm:why raw SQL returns snake_case; the transition reads the drizzle row shape
  async function load(id: string): Promise<IssueRow> {
    const rows = await harness.db.execute(sql`
      SELECT id, project_id AS "projectId", status, reopen_count AS "reopenCount"
      FROM issues WHERE id = ${id}
    `);
    return rows[0] as unknown as IssueRow;
  }

  async function stored(id: string): Promise<{ status: string; mergedAt: unknown }> {
    const rows = await harness.db.execute(sql`
      SELECT status, merged_at FROM issues WHERE id = ${id}
    `);
    return { status: String(rows[0]?.status), mergedAt: rows[0]?.merged_at ?? null };
  }

  const device = () => ({ id: ownerId, ownerId }) as const;
  const human = () => ({ type: 'user', id: ownerId }) as const;
  const SKIP_NOTE = { section: 'Skip', userFacing: '-' };

  it('refuses an agent close with nothing written, and leaves the row exactly as it was', async () => {
    const { applyStatusTransition, TransitionError } = await import(
      '../../src/issues/apply-transition.js'
    );
    const id = await insertIssue('in_progress');

    const err = await applyStatusTransition(await load(id), 'closed', device()).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TransitionError);
    expect((err as { code: string }).code).toBe('RELEASE_RECORD_REQUIRED');
    expect(await stored(id)).toEqual({ status: 'in_progress', mergedAt: null });
  });

  // cm:guard the staged close is `released -> closed`, and it is the case the first version of the rule got wrong: with a `merged_at IS NULL` condition the check read NULL here — the stamp lands later in the same transaction — and refused the path it meant to exempt. Both halves are asserted so that condition cannot come back green.
  it('refuses from `released` too, and lets it through once a note exists', async () => {
    const { applyStatusTransition } = await import('../../src/issues/apply-transition.js');
    const bare = await insertIssue('released');
    const noted = await insertIssue('released', SKIP_NOTE);

    await expect(applyStatusTransition(await load(bare), 'closed', device())).rejects.toThrow(
      'RELEASE_RECORD_REQUIRED',
    );
    expect((await stored(bare)).status).toBe('released');

    await applyStatusTransition(await load(noted), 'closed', device());
    const after = await stored(noted);
    expect(after.status).toBe('closed');
    expect(after.mergedAt).not.toBeNull();
  });

  it('leaves a human close alone — the claim is theirs to make', async () => {
    const { transitionIssueStatus } = await import('../../src/issues/apply-transition.js');
    const id = await insertIssue('in_progress');

    await transitionIssueStatus(await load(id), 'closed', human());

    expect((await stored(id)).status).toBe('closed');
  });

  it('leaves a system chain carrying `skip` alone, so the decompose cascade still closes children', async () => {
    const { applyStatusTransition } = await import('../../src/issues/apply-transition.js');
    const id = await insertIssue('in_progress');

    await applyStatusTransition(await load(id), 'closed', device(), { skip: true });

    expect((await stored(id)).status).toBe('closed');
  });

  it('leaves `dropped` alone, which is terminal without claiming a ship', async () => {
    const { applyStatusTransition } = await import('../../src/issues/apply-transition.js');
    const id = await insertIssue('in_progress');

    await applyStatusTransition(await load(id), 'dropped', device());

    expect(await stored(id)).toEqual({ status: 'dropped', mergedAt: null });
  });
});
