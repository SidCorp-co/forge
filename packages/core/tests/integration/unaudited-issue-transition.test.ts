/**
 * ISS-1107 — the fourth audited entity, proved against a real database.
 *
 * Three propositions, and the trigger is the proof of the third rather than the
 * INSERT: the audit row says what the application did, and only the trigger can
 * say what it did NOT do.
 *
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createUnauditedFixture, type UnauditedFixture } from '../helpers/unaudited-fixture.js';

const fx: UnauditedFixture = await createUnauditedFixture();

type Audited = {
  entity: string;
  entity_id: string;
  from_status: string | null;
  to_status: string;
  actor_type: string;
  actor_agency: string;
  actor_id: string | null;
  source: string;
};

async function audited(): Promise<Audited[]> {
  const rows = await fx.harness.db.execute(sql`
    SELECT entity, entity_id, from_status, to_status, actor_type, actor_agency, actor_id, source
    FROM kernel_transitions ORDER BY created_at
  `);
  return rows as unknown as Audited[];
}

const USER = (id: string) => ({ type: 'user' as const, id, agency: 'human' as const });

/**
 * The Postgres message, not drizzle's wrapper. A failed `db.execute` throws
 * `Failed query: <sql>` and hangs the server's own message off `cause`, so
 * asserting on the outer message would pass for any failure at all.
 */
async function refusalFrom(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const parts: string[] = [];
    let cursor: unknown = err;
    while (cursor instanceof Error) {
      parts.push(cursor.message);
      cursor = (cursor as { cause?: unknown }).cause;
    }
    return parts.join('\n');
  }
  throw new Error('expected the write to be refused, and it was not');
}

beforeEach(async () => {
  await fx.reset();
});

afterAll(async () => {
  await fx.harness.cleanup();
});

describe('an issue transition the application made', () => {
  it('writes one kernel_transitions row naming the issue, both statuses and the actor', async () => {
    await fx.mods.transitionIssueStatus(
      { id: fx.ids.issueId, projectId: fx.ids.projectId, status: 'open', reopenCount: 0 },
      'in_progress',
      USER(fx.ids.ownerId),
    );

    const rows = await audited();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity: 'issue',
      entity_id: fx.ids.issueId,
      from_status: 'open',
      to_status: 'in_progress',
      actor_type: 'user',
      actor_agency: 'human',
      actor_id: fx.ids.ownerId,
      source: 'issues',
    });
  });

  it('is detected nowhere, because the writer stamps the marker', async () => {
    await fx.mods.transitionIssueStatus(
      { id: fx.ids.issueId, projectId: fx.ids.projectId, status: 'open', reopenCount: 0 },
      'in_progress',
      USER(fx.ids.ownerId),
    );

    expect(await fx.detected()).toHaveLength(0);
  });

  it('leaves no audit row behind when the transaction rolls back', async () => {
    // The compare-and-set finds no row at the declared prior status, so the
    // whole transaction — audit row included — is rolled back.
    await expect(
      fx.mods.transitionIssueStatus(
        { id: fx.ids.issueId, projectId: fx.ids.projectId, status: 'testing', reopenCount: 0 },
        'in_progress',
        USER(fx.ids.ownerId),
      ),
    ).rejects.toThrow();

    expect(await audited()).toHaveLength(0);
    expect(await fx.detected()).toHaveLength(0);
  });
});

describe('an issue status write the application did not make', () => {
  it('is charted in unaudited_transitions as an `issue`', async () => {
    await fx.harness.db.execute(
      sql`UPDATE issues SET status = 'in_progress' WHERE id = ${fx.ids.issueId}`,
    );

    const rows = await fx.detected();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity: 'issue',
      entity_id: fx.ids.issueId,
      project_id: fx.ids.projectId,
      from_status: 'open',
      to_status: 'in_progress',
    });
  });

  it('carries the issue own id, rather than the NULL an unresolved row would leave', async () => {
    await fx.harness.db.execute(
      sql`UPDATE issues SET status = 'in_progress' WHERE id = ${fx.ids.issueId}`,
    );

    const [row] = await fx.detected();
    expect(row?.issue_id).toBe(fx.ids.issueId);
  });

  it('writes no kernel_transitions row, because nothing audited it', async () => {
    await fx.harness.db.execute(
      sql`UPDATE issues SET status = 'in_progress' WHERE id = ${fx.ids.issueId}`,
    );

    expect(await audited()).toHaveLength(0);
  });

  it('is not charted when the write stamps the marker itself', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: the harness hands back a Db, not the tx union
    await fx.mods.withKernelMarker(fx.harness.db as any, async (tx) => {
      await tx.execute(sql`UPDATE issues SET status = 'in_progress' WHERE id = ${fx.ids.issueId}`);
    });

    expect(await fx.detected()).toHaveLength(0);
  });

  it('is not charted for a write that changes no status', async () => {
    await fx.harness.db.execute(
      sql`UPDATE issues SET title = 'renamed, not moved' WHERE id = ${fx.ids.issueId}`,
    );

    expect(await fx.detected()).toHaveLength(0);
  });
});
