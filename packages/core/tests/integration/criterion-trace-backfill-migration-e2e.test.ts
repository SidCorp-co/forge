/**
 * Migration 0460, run by drizzle's own migrator over criteria a plan wrote through the text path: a
 * live, unlinked criterion opening `(REQ-n BC-m)` is linked to the wording of BC-m live at the
 * revision its issue was planned against; a tag of another shape and an untagged criterion stay as
 * they are; a tag the migration cannot map — another requirement's, or a code with no live wording —
 * aborts the deploy naming the row, and nothing is linked.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0460_a_forecast_move_is_kept_with_its_reason_and_a_plan_trace_links_its_criterion';

let ground: MigrationGround;
let m: MigrationDb;
let userId: string;
let projectId: string;
let issueSeq = 0;
let reqSeq = 0;

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
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'HOP', ${orgId}, ${userId})`;
});

afterEach(async () => {
  await m.drop();
});

/** A requirement at revision 1 holding `codes`; returns its id, seq and each code's wording id. */
async function requirement(codes: readonly string[]) {
  const id = randomUUID();
  reqSeq += 1;
  await m.sql`INSERT INTO requirements (id, project_id, req_seq, title) VALUES (${id}, ${projectId}, ${reqSeq}, ${`req ${reqSeq}`})`;
  await m.sql`
    INSERT INTO requirement_revisions (requirement_id, revision, spec, reason, author_id, author_agency)
    VALUES (${id}, 1, '{}'::jsonb, 'first cut', ${userId}, 'human')
  `;
  const wording = new Map<string, string>();
  for (const code of codes) {
    const [row] = await m.sql<{ id: string }[]>`
      INSERT INTO requirement_criteria (requirement_id, code, body, since_revision)
      VALUES (${id}, ${code}, ${`${code} holds`}, 1) RETURNING id
    `;
    wording.set(code, row?.id as string);
  }
  return { id, seq: reqSeq, wording };
}

/** An issue planned against revision 1 of `requirementId`, with these criteria. */
async function issue(requirementId: string, statements: readonly string[]): Promise<string> {
  const id = randomUUID();
  issueSeq += 1;
  await m.sql.begin(async (tx) => {
    await tx`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`;
    await tx`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, requirement_id, planned_revision)
      VALUES (${id}, ${projectId}, ${issueSeq}, 'planted', 'open', ${userId}, ${requirementId}, 1)
    `;
  });
  for (const [i, statement] of statements.entries()) {
    await m.sql`
      INSERT INTO issue_criteria (issue_id, n, statement, position)
      VALUES (${id}, ${i + 1}, ${statement}, ${i})
    `;
  }
  return id;
}

const links = async (issueId: string) =>
  (
    await m.sql<{ n: number; link: string | null }[]>`
      SELECT n, requirement_criterion_id AS link FROM issue_criteria
       WHERE issue_id = ${issueId} AND retired_at IS NULL ORDER BY n`
  ).map((r) => [r.n, r.link]);

/** The migration's backfill block, run again as a second deploy would meet it. */
function backfillBlock(): string {
  const file = readFileSync(
    new URL(`../../drizzle/migrations/${TAG}.sql`, import.meta.url),
    'utf8',
  );
  const at = file.indexOf('DO $$');
  return file.slice(at);
}

describe('a plan trace in the criterion text', () => {
  it("links each single (REQ-n BC-m) to its issue's requirement, and only those", async () => {
    const req = await requirement(['BC-1', 'BC-2', 'BC-6', 'BC-8']);
    const id = await issue(req.id, [
      `(REQ-${req.seq} BC-1) Every screen checks the role.`,
      `(REQ-${req.seq} BC-2) Sensitive data opens only to allowed roles.`,
      `(REQ-${req.seq} BC-6, BC-8) Create and submit need the permission.`,
      'An untagged criterion.',
    ]);

    await m.migrate();

    expect(await links(id)).toEqual([
      [1, req.wording.get('BC-1')],
      [2, req.wording.get('BC-2')],
      [3, null],
      [4, null],
    ]);
  });

  it('is idempotent: a second run finds nothing to link', async () => {
    const req = await requirement(['BC-1']);
    const id = await issue(req.id, [`(REQ-${req.seq} BC-1) Every screen checks the role.`]);
    await m.migrate();
    const once = await links(id);
    await m.sql.unsafe(backfillBlock());
    expect(await links(id)).toEqual(once);
  });
});

/** What the deploy says when the migration aborts: the driver's message and the database's beneath it. */
async function abortOf(run: Promise<void>): Promise<string> {
  try {
    await run;
  } catch (e) {
    const err = e as Error & { cause?: { message?: string } };
    return `${err.message} ${err.cause?.message ?? ''}`;
  }
  throw new Error('the migration did not abort');
}

describe('a trace it cannot map', () => {
  it("aborts naming the row whose tag names another requirement than its issue's", async () => {
    const own = await requirement(['BC-1']);
    const other = await requirement(['BC-1']);
    const id = await issue(own.id, [`(REQ-${other.seq} BC-1) Proves the other one.`]);

    expect(await abortOf(m.migrate())).toMatch(
      new RegExp(`CRITERION_TRACE_UNMAPPABLE: issue ${id} criterion 1 .*serves REQ-${own.seq}`),
    );
    expect(await links(id)).toEqual([[1, null]]);
  });

  it('aborts naming the row whose code has no live wording', async () => {
    const req = await requirement(['BC-1']);
    const id = await issue(req.id, [`(REQ-${req.seq} BC-9) A code nobody wrote.`]);

    expect(await abortOf(m.migrate())).toMatch(/CRITERION_TRACE_UNMAPPABLE: .*0 wordings of BC-9/);
    expect(await links(id)).toEqual([[1, null]]);
  });
});
