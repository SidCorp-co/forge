/**
 * ISS-1073 — migration 0284, run against a real Postgres and against real rows.
 *
 * The migration reclassifies a column whose meaning changed: `merged_commit_sha`
 * held whatever a caller passed to `forge record merged --at <sha>` and now holds
 * only a commit Forge watched land. A row still carrying a claim would look, to
 * the new writer, exactly like a row already carrying evidence — so the real
 * merge would be refused forever.
 *
 * The SQL under test is READ FROM THE MIGRATION FILE rather than restated here.
 * A copy in the test is a copy that agrees with the file on the day it is written
 * and not afterwards, and the thing being proved is what will run at the deploy.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const MIGRATION = fileURLToPath(
  new URL('../../drizzle/migrations/0286_merged_commit_sha_is_evidence.sql', import.meta.url),
);

let harness: TestDatabase;
let projectId: string;
let userId: string;

/** One issue holding a stamp, as a row that predates ISS-1073 would. */
async function seedStampedIssue(args: { commit: string | null; at: string }) {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at,
                        merged_commit_sha)
    VALUES (${id}, ${projectId}, ${Math.floor(Math.random() * 1_000_000)}, 'stamped', 'closed',
            ${userId}, ${args.at}::timestamptz, ${args.commit})
  `);
  return id;
}

/** The merged pull request Forge holds for that issue, if any. */
async function seedMergedProjection(issueId: string, commit: string) {
  const conn = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (owner_type, owner_id, provider, display_name)
    VALUES ('user', ${userId}, 'github', 'gh') RETURNING id
  `);
  const binding = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_bindings (project_id, connection_id, provider, role, config)
    VALUES (${projectId}, ${(conn[0] as { id: string }).id}, 'github', 'service', '{}'::jsonb)
    RETURNING id
  `);
  await harness.db.execute(sql`
    INSERT INTO repo_pull_requests
      (project_id, binding_id, issue_id, number, repo_full_name, title, state,
       head_ref, head_sha, base_ref, base_sha, merged_at, merge_commit_sha)
    VALUES (${projectId}, ${(binding[0] as { id: string }).id}, ${issueId},
            ${Math.floor(Math.random() * 100_000)}, 'SidCorp-co/forge', 'pr', 'merged',
            'ISS-1-x', 'headsha', 'main', 'basesha', now(), ${commit})
  `);
}

async function runMigration() {
  await harness.db.execute(sql.raw(readFileSync(MIGRATION, 'utf8')));
}

async function read(id: string) {
  const rows = await harness.db.execute<{
    merged_at: Date | string | null;
    merged_commit_sha: string | null;
  }>(sql`SELECT merged_at, merged_commit_sha FROM issues WHERE id = ${id}`);
  const row = rows[0] as { merged_at: Date | string | null; merged_commit_sha: string | null };
  return {
    mergedAt: row.merged_at === null ? null : new Date(row.merged_at),
    sha: row.merged_commit_sha,
  };
}

beforeAll(async () => {
  harness = await setupTestDatabase();
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const user = await createTestUser(harness.db);
  userId = user.id;
  projectId = (await createTestProject(harness.db, user.id)).id;
});

const FULL = 'e45b4ecf596c58e10135c25af4f7279a0a804802';
const STAMPED_AT = '2026-09-17T12:17:12.321Z';

describe('migration 0284 — merged_commit_sha becomes evidence', () => {
  // cm:guard this is the planted violation: leave the migration out and the row keeps a sha Forge
  // never verified, which the new writer reads as evidence and will never replace. That is F1 of the
  // review consult on this change, and it is the whole reason the migration exists.
  it('clears a commit no merge of Forge own backs', async () => {
    const id = await seedStampedIssue({ commit: FULL, at: STAMPED_AT });
    await runMigration();
    expect((await read(id)).sha).toBeNull();
  });

  // cm:guard `merged_at` is untouched on EVERY row, and this is the assertion that says so rather
  // than a comment claiming it. Clearing it would re-block every dependent of every marked issue in
  // the fleet, which is a bigger outage than the one this change closes.
  it('leaves the timestamp exactly where it was', async () => {
    const id = await seedStampedIssue({ commit: FULL, at: STAMPED_AT });
    await runMigration();
    expect((await read(id)).mergedAt?.toISOString()).toBe(STAMPED_AT);
  });

  it('keeps a commit the projection agrees with, because that one is evidence', async () => {
    const id = await seedStampedIssue({ commit: FULL, at: STAMPED_AT });
    await seedMergedProjection(id, FULL);
    await runMigration();
    expect((await read(id)).sha).toBe(FULL);
  });

  // cm:guard the prefix match, and it is not a convenience: `mergedCommitShaSchema` accepts 7 to 64
  // hex characters, so a caller naming `e45b4ec` for a merge GitHub reports as the full 40 named the
  // same commit. An equality test would clear it and lose an agreement Forge can see.
  it('keeps a short commit that is a prefix of the merge Forge observed', async () => {
    const id = await seedStampedIssue({ commit: 'e45b4ec', at: STAMPED_AT });
    await seedMergedProjection(id, FULL);
    await runMigration();
    expect((await read(id)).sha).toBe('e45b4ec');
  });

  it('clears a commit that disagrees with the merge Forge observed', async () => {
    const id = await seedStampedIssue({ commit: 'feedface1234567', at: STAMPED_AT });
    await seedMergedProjection(id, FULL);
    await runMigration();
    expect((await read(id)).sha).toBeNull();
  });

  it('clears a commit whose pull request Forge holds as open rather than merged', async () => {
    const id = await seedStampedIssue({ commit: FULL, at: STAMPED_AT });
    await seedMergedProjection(id, FULL);
    await harness.db.execute(sql`UPDATE repo_pull_requests SET state = 'open'`);
    await runMigration();
    expect((await read(id)).sha).toBeNull();
  });

  it('touches nothing on a row that never carried a commit', async () => {
    const id = await seedStampedIssue({ commit: null, at: STAMPED_AT });
    await runMigration();
    const row = await read(id);
    expect(row.sha).toBeNull();
    expect(row.mergedAt?.toISOString()).toBe(STAMPED_AT);
  });

  // cm:guard running it twice must be a no-op, because a migration that is not idempotent is one
  // nobody can re-apply to a database that half-took it.
  it('is idempotent', async () => {
    const kept = await seedStampedIssue({ commit: FULL, at: STAMPED_AT });
    await seedMergedProjection(kept, FULL);
    const cleared = await seedStampedIssue({ commit: 'feedface1234567', at: STAMPED_AT });
    await runMigration();
    await runMigration();
    expect((await read(kept)).sha).toBe(FULL);
    expect((await read(cleared)).sha).toBeNull();
  });
});
