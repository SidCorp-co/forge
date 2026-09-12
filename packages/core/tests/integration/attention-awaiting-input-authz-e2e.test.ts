/**
 * A row of the awaiting-input bucket reaches only a caller who holds a role on
 * the project it belongs to.
 *
 * Ownership and visibility are two different questions. `ownedForAnswer` asks
 * whether the question is the caller's to answer; it has never asked whether
 * the caller may see the project it is asked about, so a person removed from a
 * project and from its organisation kept receiving that project's rows
 * (ISS-989).
 *
 * Real Postgres, because the claim IS the WHERE clause. The unit lane's mock
 * query chain resolves whatever a case queued and ignores every predicate — its
 * own note at `me/attention-routes.test.ts` says so — so a mocked version of
 * these cases would pass against the unfixed code.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  createTestOrgMember,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let outsider: string;
let stranger: string;
let projectId: string;
let orgId: string;
let seq = 0;

describe('awaiting input reaches only a caller with a role on the project (real Postgres)', () => {
  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  // cm:guard the project is created by SOMEBODY ELSE and the caller is added to nothing. `createTestProject` seeds a fresh org with its creator as org `owner`, which derives project admin — so a fixture that creates the project as the caller has silently granted the very role these cases exist to withhold.
  beforeEach(async () => {
    await truncateAll(harness.db);
    seq = 0;
    outsider = (await createTestUser(harness.db)).id;
    stranger = (await createTestUser(harness.db)).id;
    const project = await createTestProject(harness.db, stranger);
    projectId = project.id;
    orgId = project.orgId;
  });

  /** An issue of that project the caller is owed an answer on. */
  async function blockedIssue(
    args: { assignee?: string | null; createdBy?: string; status?: string } = {},
  ): Promise<string> {
    seq += 1;
    const id = randomUUID();
    const assignee = args.assignee === undefined ? outsider : args.assignee;
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, assignee_id,
                          created_at, updated_at)
      VALUES (${id}, ${projectId}, ${seq}, ${`ISS-${seq}`}, ${args.status ?? 'needs_info'},
              ${args.createdBy ?? outsider}, ${assignee}, now(), now())
    `);
    return id;
  }

  async function question(issueId: string, cost: { claims: number }): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps,
                                   claims_held, workspaces_pinned, dependents)
      VALUES (${randomUUID()}, ${projectId}, ${issueId}, 'open', 'human', '[]'::jsonb,
              ${cost.claims}, 0, 0)
    `);
  }

  async function bucketFor(userId: string) {
    const { selectAwaitingInput } = await import('../../src/me/attention-buckets.js');
    return selectAwaitingInput(userId);
  }

  describe('a caller with no role on the project', () => {
    it('receives no row for an issue of that project assigned to them', async () => {
      await blockedIssue();

      expect(await bucketFor(outsider)).toEqual([]);
    });

    it('receives no row for an unassigned issue of that project they created', async () => {
      await blockedIssue({ assignee: null, createdBy: outsider });

      expect(await bucketFor(outsider)).toEqual([]);
    });

    // cm:guard absent, never redacted. A masked or empty-fielded entry still discloses that the issue exists, which is the disclosure this bucket was leaking in the first place.
    it('receives the row as ABSENT and not as a masked entry', async () => {
      const hidden = await blockedIssue();
      await question(hidden, { claims: 3 });

      const rows = await bucketFor(outsider);
      expect(rows).toHaveLength(0);
      expect(rows.map((r) => r.id)).not.toContain(hidden);
    });

    it('receives no row when their only organisation role is plain member', async () => {
      await createTestOrgMember(harness.db, { orgId, userId: outsider, role: 'member' });
      await blockedIssue();

      expect(await bucketFor(outsider)).toEqual([]);
    });
  });

  describe('a caller who does hold a role keeps every row they had', () => {
    // cm:guard `viewer` is in this list deliberately: the predicate is "holds ANY role", not "may write". A read-only member is owed the questions addressed to them exactly as a member is.
    for (const role of ['viewer', 'member', 'admin'] as const) {
      it(`keeps the row for an explicit project ${role}`, async () => {
        await createTestProjectMember(harness.db, { projectId, userId: outsider, role });
        const mine = await blockedIssue();

        expect((await bucketFor(outsider)).map((r) => r.id)).toEqual([mine]);
      });
    }

    // cm:guard the org half is not an extra: `effectiveProjectRole` is max(explicit, org-derived), so a predicate reading `project_members` alone would lock out the org admins who reach the project on every other surface. These two cases are what make that half falsifiable.
    for (const role of ['owner', 'admin'] as const) {
      it(`keeps the row for an org ${role} with no project_members row`, async () => {
        await createTestOrgMember(harness.db, { orgId, userId: outsider, role });
        const mine = await blockedIssue();

        expect((await bucketFor(outsider)).map((r) => r.id)).toEqual([mine]);
      });
    }

    it('leaves the cost fields and the blocker kind on the row untouched', async () => {
      await createTestProjectMember(harness.db, { projectId, userId: outsider });
      const mine = await blockedIssue();
      await question(mine, { claims: 2 });

      const [row] = await bucketFor(outsider);
      expect(row).toMatchObject({ id: mine, claimsHeld: 2, workspacesPinned: 0, dependents: 0 });
      expect(row?.blockerKind).toBe('human');
    });

    it('still ranks the expensive question above the cheap one', async () => {
      await createTestProjectMember(harness.db, { projectId, userId: outsider });
      const cheap = await blockedIssue();
      await question(cheap, { claims: 0 });
      const expensive = await blockedIssue();
      await question(expensive, { claims: 5 });

      expect((await bucketFor(outsider)).map((r) => r.id)).toEqual([expensive, cheap]);
    });
  });

  // cm:guard the row's cost and its `questionId` are read by correlated subqueries of their own, and the WHERE predicate above does not reach inside them. A crossed question row would otherwise hand this caller — who may see THIS project — a cost and an id belonging to a decision of another one (ISS-989).
  it('takes no cost and no question id from a question row naming another project', async () => {
    await createTestProjectMember(harness.db, { projectId, userId: outsider });
    const mine = await blockedIssue();
    await question(mine, { claims: 1 });
    const elsewhere = await createTestProject(harness.db, stranger);
    await harness.db.execute(sql`
      INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps,
                                   claims_held, workspaces_pinned, dependents)
      VALUES (${randomUUID()}, ${elsewhere.id}, ${mine}, 'open', 'machine', '[]'::jsonb, 9, 9, 9)
    `);

    const [row] = await bucketFor(outsider);
    expect(row).toMatchObject({ claimsHeld: 1, workspacesPinned: 0, dependents: 0 });
    expect(row?.blockerKind).toBe('human');
  });

  // cm:guard the predicate is a WHERE term and the cap is the database's, so a permitted caller gets a FULL page. Were it a filter over the returned rows, the invisible project's rows would consume slots inside the limit and this caller would be handed a short page instead of a fenced one.
  it('fills the cap from the rows the caller may see, never a page shortened by rows they may not', async () => {
    const { AWAITING_INPUT_CAP } = await import('../../src/me/attention-buckets.js');
    await createTestProjectMember(harness.db, { projectId, userId: outsider });

    const hiddenProject = await createTestProject(harness.db, stranger);
    for (let i = 0; i < AWAITING_INPUT_CAP; i += 1) {
      seq += 1;
      await harness.db.execute(sql`
        INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, assignee_id,
                            created_at, updated_at)
        VALUES (${randomUUID()}, ${hiddenProject.id}, ${seq}, ${`HIDDEN-${seq}`}, 'needs_info',
                ${outsider}, ${outsider}, now(), now())
      `);
    }
    const visible: string[] = [];
    for (let i = 0; i < AWAITING_INPUT_CAP; i += 1) visible.push(await blockedIssue());

    const rows = await bucketFor(outsider);
    expect(rows).toHaveLength(AWAITING_INPUT_CAP);
    expect(rows.every((r) => visible.includes(r.id))).toBe(true);
  });

  // cm:guard asserted for a caller who DOES hold the role, so what this pins is "the predicate landed on this query and not on the shared `issueFields` projection every bucket selects through". Asserting it for a caller with NO role would pin `needsReview`'s own missing predicate as expected behaviour — the same defect this issue fixed one function up — and turn fixing that bucket into a red test somebody has to argue with (ISS-989).
  it('leaves the needs-review bucket answering exactly as it did', async () => {
    const { selectNeedsReview } = await import('../../src/me/attention-buckets.js');
    await createTestProjectMember(harness.db, { projectId, userId: outsider });
    const reviewable = await blockedIssue({ status: 'developed' });

    expect((await selectNeedsReview(outsider)).map((r) => r.id)).toEqual([reviewable]);
  });
});
