/**
 * Migration 0535, run by drizzle's own migrator over rows the merge route stamped before it named a
 * target (catalog-fe, 2026-10-26: !312 and !313 merged into `dev`, ISS-11..19 and ISS-23 left
 * `merged_target` holding `release/stg`, a mark's word written beside the observed commit). An issue
 * whose commit is a merged request's merge commit takes that request's base as its target; one
 * delivered across several merged requests lands at the last; every other row is unchanged; a head
 * reading needs an observed commit beside it.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0535_a_host_merge_names_its_target_and_head';
const M312 = '3'.repeat(40);
const M313 = '4'.repeat(40);
const OTHER = '9'.repeat(40);
const AT312 = new Date('2026-10-26T03:40:00.000Z');
const AT313 = new Date('2026-10-26T03:45:00.000Z');

let ground: MigrationGround;
let m: MigrationDb;
let userId: string;
let projectId: string;
let bindingId: string;
let seq = 0;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

beforeEach(async () => {
  m = await ground.fresh();
  userId = randomUUID();
  const orgId = randomUUID();
  projectId = randomUUID();
  const connectionId = randomUUID();
  bindingId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'P', ${orgId}, ${userId})`;
  await m.sql`INSERT INTO integration_connections (id, owner_type, owner_id, provider, active) VALUES (${connectionId}, 'user', ${userId}, 'gitlab', true)`;
  await m.sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, active, config)
    VALUES (${bindingId}, ${connectionId}, ${projectId}, 'gitlab', 'source', true, '{}'::jsonb)`;
});

afterEach(async () => {
  await m.drop();
});

/** An issue stamped observed at `sha`, `at`, holding `target`. */
async function issue(sha: string | null, at: Date | null, target: string | null): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await m.sql.begin(async (tx) => {
    await tx`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`;
    await tx`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at, merged_commit_sha, merged_target)
      VALUES (${id}, ${projectId}, ${seq}, 'planted', 'awaiting_release', ${userId}, ${at}, ${sha}, ${target})`;
  });
  return id;
}

/** A merged request into `base` at `sha`, `at`, linked to `issues`. */
async function merged(
  number: number,
  base: string,
  sha: string,
  at: Date,
  issues: string[],
): Promise<void> {
  const id = randomUUID();
  await m.sql`
    INSERT INTO repo_pull_requests (id, project_id, binding_id, host, number, repo_full_name, title, state,
                                    head_ref, head_sha, base_ref, base_sha, merged_at, merge_commit_sha)
    VALUES (${id}, ${projectId}, ${bindingId}, 'gitlab', ${number}, 'acme/catalog-fe', ${`!${number}`},
            'merged', ${`feat/${number}`}, ${'h'.repeat(40)}, ${base}, ${'b'.repeat(40)}, ${at}, ${sha})`;
  for (const issueId of issues) {
    await m.sql`
      INSERT INTO repo_pull_request_issues (pull_request_id, issue_id, linked_by)
      VALUES (${id}, ${issueId}, 'head-ref')`;
  }
}

async function rowOf(id: string) {
  const [row] = await m.sql<
    Array<{
      merged_commit_sha: string | null;
      merged_at: Date | null;
      merged_target: string | null;
      merged_head: unknown;
    }>
  >`SELECT merged_commit_sha, merged_at, merged_target, merged_head FROM issues WHERE id = ${id}`;
  return row;
}

describe('0535: a host merge names the branch it landed on', () => {
  it('replaces the mark’s `release/stg` beside !313’s merge commit with `dev`, the request’s base', async () => {
    const iss11 = await issue(M313, AT313, 'release/stg');
    await merged(313, 'dev', M313, AT313, [iss11]);

    await m.migrate();

    expect(await rowOf(iss11)).toMatchObject({ merged_commit_sha: M313, merged_target: 'dev' });
  });

  it('fills the target the merge route left empty', async () => {
    const iss12 = await issue(M312, AT312, null);
    await merged(312, 'dev', M312, AT312, [iss12]);

    await m.migrate();

    expect((await rowOf(iss12))?.merged_target).toBe('dev');
  });

  it('moves an issue delivered by !312 and then !313 to !313, the last, with its base', async () => {
    const iss23 = await issue(M312, AT312, 'release/stg');
    await merged(312, 'dev', M312, AT312, [iss23]);
    await merged(313, 'dev', M313, AT313, [iss23]);

    await m.migrate();

    const row = await rowOf(iss23);
    expect(row).toMatchObject({ merged_commit_sha: M313, merged_target: 'dev', merged_head: null });
    expect(new Date(String(row?.merged_at)).toISOString()).toBe(AT313.toISOString());
  });

  it('leaves a commit no merged request names, and a row with no commit, as they were', async () => {
    const elsewhere = await issue(OTHER, AT312, 'release/stg');
    const unmarked = await issue(null, null, 'release/stg');
    await merged(312, 'dev', M312, AT312, [elsewhere, unmarked]);

    await m.migrate();

    expect(await rowOf(elsewhere)).toMatchObject({
      merged_commit_sha: OTHER,
      merged_target: 'release/stg',
    });
    expect(await rowOf(unmarked)).toMatchObject({
      merged_commit_sha: null,
      merged_target: 'release/stg',
    });
  });

  it('refuses a head reading on a row with no observed commit', async () => {
    const unmarked = await issue(null, null, null);
    await m.migrate();

    await expect(
      m.sql`UPDATE issues SET merged_head = ${m.sql.json({ sha: M312, treeIdentical: true, why: null, readAt: AT312.toISOString() })} WHERE id = ${unmarked}`,
    ).rejects.toThrow(/issues_merged_head_chk/);
  });
});
