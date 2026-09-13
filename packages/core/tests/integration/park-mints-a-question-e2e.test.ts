/**
 * ISS-996 — a park that says what would settle it mints the question, in the
 * transition's own transaction, against real Postgres.
 *
 * The claim cannot be made against a mock: what it asserts is that the status
 * write, the reason comment and the `agent_questions` row are one commit, and a
 * mocked transaction is exactly the thing that cannot tell you that.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('a park mints the question it is owed', () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  });

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function anIssue(projectId: string, ownerId: string, status = 'in_progress') {
    const rows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO issues (project_id, title, status, created_by_id)
      VALUES (${projectId}, 'a park', ${status}, ${ownerId})
      RETURNING id
    `);
    return (rows[0] as { id: string }).id;
  }

  async function questionsOn(issueId: string) {
    return harness.db.execute<{ id: string; status: string; steps: unknown }>(sql`
      SELECT id, status, steps FROM agent_questions WHERE issue_id = ${issueId}
    `);
  }

  async function park(
    args: { issueId: string; projectId: string; from?: string; to?: string },
    actor: { type: 'device'; id: string; ownerId: string } | { type: 'user'; id: string },
    options: Record<string, unknown>,
  ) {
    const { transitionIssueStatus } = await import('../../src/issues/apply-transition.js');
    return transitionIssueStatus(
      {
        id: args.issueId,
        projectId: args.projectId,
        status: (args.from ?? 'in_progress') as never,
        reopenCount: 0,
      },
      (args.to ?? 'needs_info') as never,
      actor as never,
      options as never,
    );
  }

  it('mints a free-text round whose prompt is the reason and whose need is what would settle it', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const device = await createTestDevice(harness.db, owner.id);
    const issueId = await anIssue(project.id, owner.id);

    await park(
      { issueId, projectId: project.id },
      { type: 'device', id: device.id, ownerId: owner.id },
      {
        transitionReason:
          'the staging API rejects every write and I cannot tell whether that is expected',
        needs: 'whether staging is meant to be read-only this week',
      },
    );

    const rows = await questionsOn(issueId);
    expect(rows).toHaveLength(1);
    const row = rows[0] as { status: string; steps: Array<Record<string, unknown>> };
    expect(row.status).toBe('open');
    expect(row.steps).toHaveLength(1);
    const step = row.steps[0] as Record<string, unknown>;
    expect(step.answerShape).toBe('free_text');
    expect(step.prompt).toContain('staging API rejects');
    expect(step.needed).toBe('whether staging is meant to be read-only this week');
    expect(step.options, 'a free-text round carries no options at all').toBeUndefined();
  });

  // cm:guard the park a PERSON entered mints nothing, and this is the same line `issues/autonomous-park.ts` draws for the `waiting` rewrite: a person who stopped the work owns their own resume, and minting a question would put their own pause in front of them as a thing they are owed.
  it('mints nothing for a person, however the park is worded', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const issueId = await anIssue(project.id, owner.id);

    await park(
      { issueId, projectId: project.id },
      { type: 'user', id: owner.id },
      {
        transitionReason: 'stopping this until the contract is signed',
        needs: 'the signed contract',
      },
    );

    expect(await questionsOn(issueId)).toHaveLength(0);
  });

  // cm:guard the absence of `needs` is TODAY'S behaviour preserved, not a defect: the driver that would send it ships from another repo on its own clock, and a park refused for want of the field would stop every run in the fleet the day this deployed.
  it('leaves a park with no stated need exactly as it was — reason comment, no question', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const device = await createTestDevice(harness.db, owner.id);
    const issueId = await anIssue(project.id, owner.id);

    const out = await park(
      { issueId, projectId: project.id },
      { type: 'device', id: device.id, ownerId: owner.id },
      { transitionReason: 'blocked on something I cannot name yet' },
    );

    expect(out.status).toBe('needs_info');
    expect(await questionsOn(issueId)).toHaveLength(0);
    const comments = await harness.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM comments WHERE issue_id = ${issueId}
    `);
    expect((comments[0] as { n: number }).n).toBeGreaterThan(0);
  });

  // cm:guard an agent's `waiting` is rewritten to `needs_info` at write time, and the mint must follow the REWRITE rather than the ask — reading the requested status here would skip every park that arrived by this door, which is the one 27 parks used before the rewrite existed.
  it('mints for an agent that asked for `waiting`, because the park lands on the answerable status', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const device = await createTestDevice(harness.db, owner.id);
    const issueId = await anIssue(project.id, owner.id);

    const out = await park(
      { issueId, projectId: project.id, to: 'waiting' },
      { type: 'device', id: device.id, ownerId: owner.id },
      {
        transitionReason: 'I need the deploy token to finish this',
        waitingKind: 'needs_resource',
        needs: 'a deploy token for the staging environment',
      },
    );

    expect(out.status).toBe('needs_info');
    const rows = await questionsOn(issueId);
    expect(rows).toHaveLength(1);
    const step = (rows[0] as { steps: Array<Record<string, unknown>> }).steps[0] as Record<
      string,
      unknown
    >;
    expect(step.needed).toBe('a deploy token for the staging environment');
  });

  // cm:guard the park and its question are ONE commit. A question written after the status would be a round nobody can see on an issue that already reads `needs_info`, and a crash between the two is what makes that reachable rather than theoretical.
  it('moves no status when the question cannot be written', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const device = await createTestDevice(harness.db, owner.id);
    const issueId = await anIssue(project.id, owner.id);

    await harness.db.execute(sql`
      ALTER TABLE agent_questions ADD CONSTRAINT iss996_refuse_every_insert CHECK (false) NOT VALID
    `);
    await harness.db.execute(
      sql`ALTER TABLE agent_questions VALIDATE CONSTRAINT iss996_refuse_every_insert`,
    );

    await expect(
      park(
        { issueId, projectId: project.id },
        { type: 'device', id: device.id, ownerId: owner.id },
        {
          transitionReason: 'a reason',
          needs: 'a thing',
        },
      ),
    ).rejects.toThrow();

    await harness.db.execute(sql`
      ALTER TABLE agent_questions DROP CONSTRAINT iss996_refuse_every_insert
    `);

    const after = await harness.db.execute<{ status: string }>(sql`
      SELECT status FROM issues WHERE id = ${issueId}
    `);
    expect((after[0] as { status: string }).status).toBe('in_progress');
    const comments = await harness.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM comments WHERE issue_id = ${issueId}
    `);
    expect((comments[0] as { n: number }).n, 'the reason comment rolled back with it').toBe(0);
  });
});
