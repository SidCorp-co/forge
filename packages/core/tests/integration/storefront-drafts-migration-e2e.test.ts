/**
 * Migration 0514 (ISS-613), run by drizzle's own migrator over verdicts written before it: a
 * one-workflow storefront_draft verdict becomes a one-element `storefront_drafts` list holding the
 * same workflow and draft, so it reads exactly as it did; a verdict of another kind is left with
 * none; a storefront_draft row with no environment, which the 0360 CHECK let through, aborts the
 * deploy naming it. After it, the CHECK refuses an empty list, a repeated workflow, a part with no
 * version and a row with no environment, and takes a list of several distinct workflow drafts.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0514_a_storefront_verdict_names_every_workflow_draft';

let ground: MigrationGround;
let m: MigrationDb;
let issueId: string;
let criterionId: string;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

beforeEach(async () => {
  m = await ground.fresh();
  const userId = randomUUID();
  const orgId = randomUUID();
  const projectId = randomUUID();
  issueId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'P', ${orgId}, ${userId})`;
  await m.sql.begin(async (tx) => {
    await tx`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`;
    await tx`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${issueId}, ${projectId}, 1, 'planted', 'open', ${userId})
    `;
  });
  const [row] = await m.sql<{ id: string }[]>`
    INSERT INTO issue_criteria (issue_id, n, statement, position)
    VALUES (${issueId}, 1, 'the lead reaches booked', 0) RETURNING id
  `;
  criterionId = row?.id as string;
});

afterEach(async () => {
  await m.drop();
});

/** A storefront_draft verdict as 0360 stored it: one workflow, one draft. */
async function oldDraftVerdict(workflowId: string, draftVersion: string, env: string | null) {
  const [row] = await m.sql<{ id: string }[]>`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, author_agency, identity_kind,
                                    storefront_workflow_id, storefront_draft_version,
                                    storefront_environment, corroboration, reason)
    VALUES (${criterionId}, ${issueId}, 'pass', 'agent', 'storefront_draft', ${workflowId},
            ${draftVersion}, ${env}, ${env === null ? null : 'corroborated'}, 'judged on beta')
    RETURNING id
  `;
  return row?.id as string;
}

const insertDrafts = (drafts: unknown, env: string | null = 'beta') => m.sql`
  INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, author_agency, identity_kind,
                                  storefront_drafts, storefront_environment, corroboration, reason)
  VALUES (${criterionId}, ${issueId}, 'pass', 'agent', 'storefront_draft',
          ${m.sql.json(drafts as never)}, ${env}, 'corroborated', 'judged on beta')
`;

describe('0514: a storefront verdict names every workflow draft', () => {
  it('keeps an old one-workflow verdict as a one-element list, and a commit verdict with none', async () => {
    const draft = await oldDraftVerdict('253', 'a1b2c3d4e5', 'beta');
    const [commit] = await m.sql<{ id: string }[]>`
      INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, author_agency, identity_kind, commit_sha)
      VALUES (${criterionId}, ${issueId}, 'pass', 'agent', 'commit', ${'a'.repeat(40)}) RETURNING id
    `;
    await m.migrate();
    const rows = await m.sql<
      { id: string; storefront_drafts: unknown; storefront_environment: string | null }[]
    >`
      SELECT id, storefront_drafts, storefront_environment FROM criterion_verdicts ORDER BY created_at
    `;
    expect(rows.find((r) => r.id === draft)).toMatchObject({
      storefront_drafts: [{ workflowId: '253', draftVersion: 'a1b2c3d4e5' }],
      storefront_environment: 'beta',
    });
    expect(rows.find((r) => r.id === commit?.id)?.storefront_drafts).toBeNull();
    const columns = await m.sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'criterion_verdicts' AND column_name IN ('storefront_workflow_id', 'storefront_draft_version')
    `;
    expect(columns).toHaveLength(0);
  });

  it('aborts naming a storefront_draft verdict with no environment, moving nothing', async () => {
    const draft = await oldDraftVerdict('253', 'a1b2c3d4e5', null);
    const refusal = await m.migrate().then(
      () => 'migrated',
      (e: Error & { cause?: { message?: string } }) => `${e.message} ${e.cause?.message ?? ''}`,
    );
    expect(refusal).toContain(
      `STOREFRONT_DRAFT_UNREPRESENTABLE: verdict ${draft} on issue ${issueId}`,
    );
    const [kept] = await m.sql<{ storefront_workflow_id: string }[]>`
      SELECT storefront_workflow_id FROM criterion_verdicts WHERE id = ${draft}
    `;
    expect(kept?.storefront_workflow_id).toBe('253');
  });

  it('takes several distinct workflow drafts and refuses a list that is wrong', async () => {
    await m.migrate();
    await insertDrafts([
      { workflowId: '253', draftVersion: 'a1b2c3d4e5' },
      { workflowId: '190', draftVersion: 'f6a7b8c9d0' },
    ]);
    const refused = [
      ['an empty list', []],
      [
        'a repeated workflow',
        [
          { workflowId: '253', draftVersion: 'a1' },
          { workflowId: '253', draftVersion: 'b2' },
        ],
      ],
      ['a part with no version', [{ workflowId: '253' }]],
      ['a part with an extra key', [{ workflowId: '253', draftVersion: 'a1', theme: 'x' }]],
      ['a number for a workflow id', [{ workflowId: 253, draftVersion: 'a1' }]],
      ['an object, not a list', { workflowId: '253', draftVersion: 'a1' }],
    ] as const;
    const accepted: string[] = [];
    for (const [what, drafts] of refused) {
      const answer = await insertDrafts(drafts).then(
        () => 'written',
        (e: Error) => e.message,
      );
      if (!/criterion_verdicts_storefront_chk/.test(answer)) accepted.push(`${what}: ${answer}`);
    }
    expect(accepted).toEqual([]);
    await expect(
      insertDrafts([{ workflowId: '253', draftVersion: 'a1' }], null),
      'no environment',
    ).rejects.toThrow(/criterion_verdicts_storefront_chk/);
  });
});
