/**
 * The awaiting-input bucket is ordered by what waiting COSTS, not by recency.
 *
 * A question holding a runner claim and a pinned worktree denies those to
 * everything else for as long as it waits; one holding nothing denies nothing.
 * Ordered by `updatedAt` the cheap question that arrived a minute ago outranks
 * the expensive one that has been waiting since yesterday, which is the bucket
 * showing its reader the row that matters least (ISS-964 criteria 19 and 23).
 *
 * Real Postgres, because the claim is an ORDER BY over three correlated
 * subqueries — a mocked query chain returns whatever order the mock was handed,
 * and its `orderBy` is an identity function.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let userId: string;
let projectId: string;
let seq = 0;

describe('awaiting input is ranked by the cost of waiting (real Postgres)', () => {
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
    userId = (await createTestUser(harness.db)).id;
    projectId = (await createTestProject(harness.db, userId)).id;
    await createTestProjectMember(harness.db, { projectId, userId });
  });

  /** An issue the caller is owed an answer on, `ageDays` old. */
  async function blockedIssue(ageDays: number, status = 'needs_info'): Promise<string> {
    seq += 1;
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, assignee_id,
                          created_at, updated_at)
      VALUES (${id}, ${projectId}, ${seq}, ${`ISS-${seq}`}, ${status}, ${userId}, ${userId},
              now() - (${ageDays}::int * interval '1 day'),
              now() - (${ageDays}::int * interval '1 day'))
    `);
    return id;
  }

  async function question(
    issueId: string,
    cost: { claims?: number; workspaces?: number; dependents?: number },
    status = 'open',
  ): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps,
                                   claims_held, workspaces_pinned, dependents)
      VALUES (${randomUUID()}, ${projectId}, ${issueId}, ${status}, 'human', '[]'::jsonb,
              ${cost.claims ?? 0}, ${cost.workspaces ?? 0}, ${cost.dependents ?? 0})
    `);
  }

  async function bucket(): Promise<string[]> {
    const { selectAwaitingInput } = await import('../../src/me/attention-buckets.js');
    const rows = await selectAwaitingInput(userId);
    return rows.map((r) => r.title);
  }

  // cm:guard every ordering case here sets age AGAINST cost deliberately, and that is what makes them falsifying: measured while writing this, restoring `desc(updatedAt)` turns 6 of the 7 red. Let age and cost agree in any one of them and it passes against the order it exists to replace.
  it('puts the expensive question above the cheap one that arrived later', async () => {
    const expensive = await blockedIssue(3);
    await question(expensive, { claims: 2, workspaces: 1, dependents: 4 });
    const cheap = await blockedIssue(0);
    await question(cheap, {});

    expect(await bucket()).toEqual(['ISS-1', 'ISS-2']);
  });

  // cm:guard the ages run OPPOSITE to the costs on purpose: newest carries the cheapest question, oldest the dearest, so neither `desc(updatedAt)` nor `asc(updatedAt)` can produce this order by accident.
  it('ranks a held claim above a pinned workspace, and that above a dependent', async () => {
    const claims = await blockedIssue(9);
    await question(claims, { claims: 1 });
    const workspaces = await blockedIssue(4);
    await question(workspaces, { workspaces: 9 });
    const dependents = await blockedIssue(0);
    await question(dependents, { dependents: 9 });

    expect(await bucket()).toEqual(['ISS-1', 'ISS-2', 'ISS-3']);
    expect([claims, workspaces, dependents].every(Boolean)).toBe(true);
  });

  // cm:guard age must still BREAK ties and still be returned: the row carries `updatedAt` because the reader is told how long it has waited, and a cost-only order that dropped it would rank two equal-cost questions arbitrarily between runs.
  it('falls back to age when the cost is equal, oldest first', async () => {
    await blockedIssue(1);
    await blockedIssue(5);
    await blockedIssue(3);

    const { selectAwaitingInput } = await import('../../src/me/attention-buckets.js');
    const rows = await selectAwaitingInput(userId);
    expect(rows.map((r) => r.title)).toEqual(['ISS-2', 'ISS-3', 'ISS-1']);
    for (const row of rows) expect(row.updatedAt).toBeTruthy();
  });

  // cm:guard an issue blocked with NO question row is still in the bucket. `waiting` and `needs_info` are reachable by a human hand as well as by an agent asking, and a join that dropped the row would hide every block a person set.
  it('keeps an issue a human blocked by hand, below the ones that cost something', async () => {
    const asked = await blockedIssue(9);
    await question(asked, { claims: 1 });
    const byHand = await blockedIssue(0, 'waiting');

    expect(await bucket()).toEqual(['ISS-1', 'ISS-2']);
    expect(byHand).toBeTruthy();
  });

  // cm:guard only an OPEN question costs anything. An answered or voided one holds no claim and no worktree, so counting it would rank a settled decision above a live one forever.
  it('ignores the cost of a question that is no longer open', async () => {
    const live = await blockedIssue(5);
    await question(live, { claims: 1 });
    const settled = await blockedIssue(0);
    await question(settled, { claims: 9, workspaces: 9, dependents: 9 }, 'answered');

    expect(await bucket()).toEqual(['ISS-1', 'ISS-2']);
  });

  // cm:guard two parked runs on one issue hold two sets of resources, so the costs SUM rather than taking the larger. A max would rank one issue holding 1+1 claims level with one holding a single claim.
  it('adds up the cost of every open question on one issue', async () => {
    const one = await blockedIssue(0);
    await question(one, { claims: 1, workspaces: 5 });
    const two = await blockedIssue(9);
    await question(two, { claims: 1 });
    await question(two, { claims: 1 });

    expect(await bucket()).toEqual(['ISS-2', 'ISS-1']);
  });

  // cm:guard the cap is 20 and not `PER_BUCKET`, and this asserts the NUMBER because the justification is a number: 56 issues sat at `waiting`/`needs_info` across 17 projects fleet-wide on 2026-09-08, so a cap of 5 renders 91% of the population unreachable.
  it('returns up to the declared cap rather than five', async () => {
    const { AWAITING_INPUT_CAP } = await import('../../src/me/attention-buckets.js');
    expect(AWAITING_INPUT_CAP).toBe(20);

    for (let i = 0; i < AWAITING_INPUT_CAP + 3; i += 1) await blockedIssue(i);
    expect((await bucket()).length).toBe(AWAITING_INPUT_CAP);
  });

  // cm:why criterion 53 wants the cost of waiting SHOWN, not merely obeyed. The ordering shipped without the numbers, so a reader saw the right row first and no reason why — and `blocker_kind`, which says WHO can end the wait, was not on the row at all. A queue whose order cannot be explained is one whose order gets overridden by hand (ISS-964 criteria 19, 53).
  it('carries the cost it ordered by, and who can end the wait', async () => {
    const { selectAwaitingInput } = await import('../../src/me/attention-buckets.js');
    const issueId = await blockedIssue(1);
    await question(issueId, { claims: 2, workspaces: 1, dependents: 3 });

    const [row] = await selectAwaitingInput(userId);
    if (!row) throw new Error('the bucket must return the issue it ordered');

    expect(
      [row.claimsHeld, row.workspacesPinned, row.dependents],
      'the three numbers the order is computed from must reach the reader, or the queue shows a rank with no visible reason',
    ).toEqual([2, 1, 3]);
    expect(
      row.blockerKind,
      'and who can resolve it: a machine wait and a human wait sit in the same bucket and mean different things to the person reading it',
    ).toBe('human');
  });

  // cm:guard the numbers come from OPEN questions only, matching the ordering's own rule: a settled question holds no claim, so counting it would show a cost that is not being paid.
  it('shows nothing for a question already answered', async () => {
    const { selectAwaitingInput } = await import('../../src/me/attention-buckets.js');
    const issueId = await blockedIssue(1);
    await question(issueId, { claims: 5 }, 'answered');

    const [row] = await selectAwaitingInput(userId);
    expect([row?.claimsHeld, row?.blockerKind]).toEqual([0, null]);
  });
});
