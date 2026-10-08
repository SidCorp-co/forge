/**
 * The Needs you queue lists an issue holding an open question only where the question moves the
 * issue's work state (ISS-1156): a question left on a draft, closed or dropped issue is not
 * something a person has to act on, and an issue at `waiting` or `needs_info` is listed with no
 * question at all.
 *
 * Real Postgres, because the claim is the WHERE clause; the unit lane's mocked query chain ignores
 * every predicate and would pass against the unfixed code.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import { AWAITING_INPUT_STATUSES } from '../../src/issues/status-sets.js';
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

describe('Needs you lists a question only where it moves the work state (real Postgres)', () => {
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

  async function issueAt(status: string, withQuestion: boolean): Promise<string> {
    seq += 1;
    const id = randomUUID();
    // `closed` means the work shipped, so the schema refuses it with no merge on the row.
    const mergedAt = status === 'closed' ? sql`now()` : sql`NULL`;
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, assignee_id,
                          merged_at, created_at, updated_at)
      VALUES (${id}, ${projectId}, ${seq}, ${`ISS-${seq} at ${status}`}, ${status}, ${owner},
              ${owner}, ${mergedAt}, now(), now())
    `);
    if (withQuestion) {
      await harness.db.execute(sql`
        INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps,
                                     claims_held, workspaces_pinned, dependents)
        VALUES (${randomUUID()}, ${projectId}, ${id}, 'open', 'human', '[]'::jsonb, 0, 0, 0)
      `);
    }
    return id;
  }

  async function listed(): Promise<string[]> {
    const { selectAwaitingInput } = await import('../../src/me/attention-buckets.js');
    return (await selectAwaitingInput(owner)).map((r) => r.id);
  }

  it.each(['draft', 'closed', 'dropped'])(
    'does not list an issue at %s that holds an open question',
    async (status) => {
      await issueAt(status, true);
      expect(await listed()).toEqual([]);
    },
  );

  it.each([
    'open',
    'confirmed',
    'in_progress',
    'developed',
    'testing',
    'releasing',
    'awaiting_release',
  ])('lists an issue at %s that holds an open question', async (status) => {
    const id = await issueAt(status, true);
    expect(await listed()).toEqual([id]);
  });

  it.each([...AWAITING_INPUT_STATUSES])(
    'lists an issue at %s with no question at all',
    async (status) => {
      const id = await issueAt(status, false);
      expect(await listed()).toEqual([id]);
    },
  );

  it('does not list an in-flight issue that holds no question', async () => {
    await issueAt('in_progress', false);
    expect(await listed()).toEqual([]);
  });
});
