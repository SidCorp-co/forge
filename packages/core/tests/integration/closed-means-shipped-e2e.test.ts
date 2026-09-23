/**
 * ISS-1108 — the database's own half of "`closed` means the work shipped".
 *
 * `issues/apply-transition.ts` refuses such a close by name, and that refusal is
 * proved in unit tests against the transition writer. This file proves the half
 * that holds whatever wrote the row: a `BEFORE UPDATE`/`BEFORE INSERT` trigger
 * installed by migration 0304, which no application code can be routed around.
 * A mocked `db.execute` can express none of it.
 *
 * The migration's own text is read from the migration file rather than restated,
 * so what is proved is what will run at the deploy. Its rule is about the
 * TRANSITION into `closed`: a row that already stands there without a claim
 * predates the rule, is counted and named rather than changed, and stays
 * writable — the state-shaped version of this trigger made 597 issues on
 * forge-beta permanently un-updatable and aborted the deploy that would have
 * installed it.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// The unmark cases below import the marker, which reads the environment at module load.
process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const MIGRATION = fileURLToPath(
  new URL('../../drizzle/migrations/0304_closed_means_shipped.sql', import.meta.url),
);

let harness: TestDatabase;
let projectId: string;
let userId: string;
let seq = 0;

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

async function seedIssue(opts: { status?: string; merged?: boolean } = {}) {
  const id = randomUUID();
  const issSeq = ++seq;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, created_by_id, title, description, status, merged_at)
    VALUES (${id}, ${projectId}, ${issSeq}, ${userId}, 'a row the rule is judged on', 'fixture',
            ${opts.status ?? 'in_progress'}, ${opts.merged ? sql`now()` : null})
  `);
  return { id, issSeq };
}

async function statusOf(id: string): Promise<string> {
  const rows = await harness.db.execute<{ status: string }>(
    sql`SELECT status FROM issues WHERE id = ${id}`,
  );
  return (rows[0] as { status: string }).status;
}

/** Both triggers, so a row the new meaning cannot represent can be planted. */
async function dropTheRule() {
  await harness.db.execute(sql`DROP TRIGGER IF EXISTS trg_issues_closed_means_shipped ON issues`);
  await harness.db.execute(
    sql`DROP TRIGGER IF EXISTS trg_issues_closed_means_shipped_ins ON issues`,
  );
}

/** The migration's own NOTICEs, which the harness client is built to swallow. */
async function noticesFromMigration(): Promise<string[]> {
  const captured: string[] = [];
  const client = postgres(harness.url, {
    max: 1,
    onnotice: (n) => {
      if (n.message) captured.push(n.message);
    },
  });
  try {
    for (const statement of readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')) {
      if (statement.trim()) await client.unsafe(statement);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
  return captured;
}

async function runMigration() {
  const text = readFileSync(MIGRATION, 'utf8');
  for (const statement of text.split('--> statement-breakpoint')) {
    if (statement.trim()) await harness.db.execute(sql.raw(statement));
  }
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  // The unmark cases import `merge-marker`, which builds its own pool from the environment.
  process.env.DATABASE_URL = harness.url;
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, owner.id);
  userId = owner.id;
  projectId = project.id;
});

afterAll(async () => {
  await harness.cleanup();
});

describe('no route reaches `closed` without the shipped-work claim (ISS-1108)', () => {
  it('refuses a raw UPDATE, naming the issue, the rule and the exit', async () => {
    const { id, issSeq } = await seedIssue();

    const message = await refusalFrom(() =>
      harness.db.execute(sql`UPDATE issues SET status = 'closed' WHERE id = ${id}`),
    );

    expect(message).toContain('ISS-1108');
    expect(message).toContain(id);
    expect(message).toContain(`ISS-${issSeq}`);
    expect(message).toContain('merged_at');
    expect(message).toContain('dropped');
    expect(await statusOf(id)).toBe('in_progress');
  });

  it('refuses a row created `closed` with no merged_at, so "no way in" means every way', async () => {
    const message = await refusalFrom(() =>
      harness.db.execute(sql`
        INSERT INTO issues (id, project_id, iss_seq, created_by_id, title, description, status)
        VALUES (${randomUUID()}, ${projectId}, ${++seq}, ${userId}, 'born closed', 'fixture', 'closed')
      `),
    );

    expect(message).toContain('ISS-1108');
    expect(message).toContain('dropped');
  });

  it('refuses the close even when the same statement sets other columns', async () => {
    const { id } = await seedIssue();

    const message = await refusalFrom(() =>
      harness.db.execute(
        sql`UPDATE issues SET title = 'renamed on the way out', status = 'closed' WHERE id = ${id}`,
      ),
    );

    expect(message).toContain('ISS-1108');
    expect(await statusOf(id)).toBe('in_progress');
  });

  it('lets the same write through once the row can show it shipped', async () => {
    const { id } = await seedIssue({ merged: true });

    await harness.db.execute(sql`UPDATE issues SET status = 'closed' WHERE id = ${id}`);

    expect(await statusOf(id)).toBe('closed');
  });

  it('leaves `dropped` alone, which is the exit for work that will not happen', async () => {
    const { id } = await seedIssue();

    await harness.db.execute(sql`UPDATE issues SET status = 'dropped' WHERE id = ${id}`);

    expect(await statusOf(id)).toBe('dropped');
  });
});

describe('migration 0304 carries on over the rows it cannot represent (ISS-1108)', () => {
  it('counts them, names one, changes none of them, and leaves them updatable', async () => {
    await dropTheRule();
    try {
      const { id, issSeq } = await seedIssue({ status: 'closed' });
      const other = await seedIssue({ status: 'closed' });
      // The notice names the OLDEST, so which of the two that is is decided here rather
      // than by whichever insert the clock happened to separate.
      await harness.db.execute(
        sql`UPDATE issues SET updated_at = now() - interval '1 day' WHERE id = ${id}`,
      );

      const notice = (await noticesFromMigration()).find((m) => m.includes('ISS-1108'));

      expect(notice).toContain('2 issue row(s)');
      expect(notice).toContain(id);
      expect(notice).toContain(`ISS-${issSeq}`);
      expect(notice).toContain('dropped');

      // Named and left standing: not stamped, not dropped, not cleaned away.
      const rows = await harness.db.execute<{ status: string; merged_at: Date | null }>(
        sql`SELECT status, merged_at FROM issues WHERE id IN (${id}, ${other.id})`,
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row).toMatchObject({ status: 'closed', merged_at: null });

      // The rule reaches the transition and not the state, so a row already standing there
      // is still writable. That is what the abort was standing in front of: with the wide
      // trigger installed, every one of these rows is refused for the rest of its life.
      await harness.db.execute(
        sql`UPDATE issues SET title = 'renamed while standing closed' WHERE id = ${id}`,
      );
      await harness.db.execute(sql`UPDATE issues SET updated_at = now() WHERE id = ${id}`);

      // And nothing may newly reach the state they stand in.
      const live = await seedIssue();
      expect(
        await refusalFrom(() =>
          harness.db.execute(sql`UPDATE issues SET status = 'closed' WHERE id = ${live.id}`),
        ),
      ).toContain('ISS-1108');
    } finally {
      await runMigration();
    }
  });

  it('installs the rule where it finds nothing it cannot represent', async () => {
    await dropTheRule();
    await seedIssue({ status: 'closed', merged: true });

    await runMigration();

    const { id } = await seedIssue();
    expect(
      await refusalFrom(() =>
        harness.db.execute(sql`UPDATE issues SET status = 'closed' WHERE id = ${id}`),
      ),
    ).toContain('ISS-1108');
  });
});

describe('withdrawing the claim from under a closed issue (ISS-1108)', () => {
  it('answers a caller whose status is already stale with the named refusal, not the trigger', async () => {
    const { id } = await seedIssue({ status: 'awaiting_release', merged: true });
    const { applyMergeMarker, MergeMarkerError } = await import('../../src/issues/merge-marker.js');
    const actor = {
      agency: 'human' as const,
      commentAuthorId: userId,
      hookActor: { type: 'user' as const, id: userId, agency: 'human' as const },
    };

    // The caller reads the row, and it is closed before the unmark reaches the database. Passing
    // the row it read IS that race: the guard the statement carries is the only thing standing
    // between this call and the trigger's own message, which names a close nobody attempted.
    const asRead = { id, projectId, mergedAt: new Date() };
    await harness.db.execute(sql`UPDATE issues SET status = 'closed' WHERE id = ${id}`);

    const err = await applyMergeMarker({ issue: asRead, op: 'unmark', actor }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MergeMarkerError);
    expect((err as InstanceType<typeof MergeMarkerError>).code).toBe('UNMARK_REQUIRES_NOT_CLOSED');
    expect((err as Error).message).not.toContain('cannot enter');
    const rows = await harness.db.execute<{ status: string; merged_at: Date | null }>(
      sql`SELECT status, merged_at FROM issues WHERE id = ${id}`,
    );
    expect(rows[0]?.status).toBe('closed');
    expect(rows[0]?.merged_at).not.toBeNull();
    expect(
      await harness.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM comments WHERE issue_id = ${id}`,
      ),
    ).toMatchObject([{ n: 0 }]);
  });

  it('clears the claim on a row the guard admits', async () => {
    const { id } = await seedIssue({ status: 'awaiting_release', merged: true });
    const { applyMergeMarker } = await import('../../src/issues/merge-marker.js');

    const res = await applyMergeMarker({
      issue: { id, projectId, mergedAt: new Date() },
      op: 'unmark',
      actor: {
        agency: 'human' as const,
        commentAuthorId: userId,
        hookActor: { type: 'user' as const, id: userId, agency: 'human' as const },
      },
    });

    expect(res.action).toBe('unmarked');
    const rows = await harness.db.execute<{ merged_at: Date | null }>(
      sql`SELECT merged_at FROM issues WHERE id = ${id}`,
    );
    expect(rows[0]?.merged_at).toBeNull();
  });
});
