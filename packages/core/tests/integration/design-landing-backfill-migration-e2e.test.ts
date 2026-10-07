/**
 * Migration 0450, run by drizzle's own migrator over approvals decided before ISS-262: an unmarked
 * design issue is stamped as `recordDesignLanding` would have stamped it, at the approval's decided_at,
 * on its project's shape, with the decision's notice; a build issue, a marked issue, a finished one and
 * one whose project declares no shape stay as they are; a shape no schema admits aborts naming it.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0450_an_approval_before_its_landing_rule_is_recorded';
const FIRST = new Date('2026-10-06T18:32:02.000Z');
const SECOND = new Date('2026-10-06T18:33:18.000Z');

let ground: MigrationGround;
let m: MigrationDb;
let userId: string;
let orgId: string;
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
  orgId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
});

afterEach(async () => {
  await m.drop();
});

/** A project whose document declares `source` (none at all when null). */
async function project(source: string | null): Promise<string> {
  const id = randomUUID();
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${id}, ${`p-${id.slice(0, 8)}`}, 'P', ${orgId}, ${userId})`;
  if (source !== null) {
    await m.sql`
      INSERT INTO project_config_documents (project_id, revision, document, updated_by)
      VALUES (${id}, 1, ${m.sql.json({ source: { type: source } })}, ${userId})
    `;
  }
  return id;
}

async function issue(
  projectId: string,
  status = 'open',
  mark: { at: Date; sha?: string; landing?: string } | null = null,
): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await m.sql.begin(async (tx) => {
    await tx`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`;
    await tx`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at, merged_commit_sha, merged_landing)
      VALUES (${id}, ${projectId}, ${seq}, 'planted', ${status}, ${userId}, ${mark?.at ?? null},
              ${mark?.sha ?? null}, ${mark?.landing ?? null})
    `;
  });
  return id;
}

/** A workflow whose revisions are drawn under issues: `approved` maps each revision to [issue, decided_at]. */
async function workflow(
  projectId: string,
  flow: string,
  approved: Array<[number, string, Date]>,
): Promise<string> {
  const id = randomUUID();
  const top = Math.max(...approved.map(([r]) => r));
  await m.sql`
    INSERT INTO project_workflows (id, project_id, flow, kind, revision, document, design_status, approved_revision, written_by_user)
    VALUES (${id}, ${projectId}, ${flow}, 'flow', ${top}, '{}'::jsonb, 'approved', ${top}, ${userId})
  `;
  for (const [revision, drawnUnder, at] of approved) {
    await m.sql`
      INSERT INTO project_workflow_designs (workflow_id, revision, document, proposed_by_user, decision, decided_by_user, decided_at, design_issue_id)
      VALUES (${id}, ${revision}, '{}'::jsonb, ${userId}, 'approve', ${userId}, ${at}, ${drawnUnder})
    `;
  }
  return id;
}

async function markOf(id: string) {
  const [row] = await m.sql<
    Array<{
      merged_at: Date | null;
      merged_commit_sha: string | null;
      merged_landing: string | null;
      merged_artifacts: unknown;
    }>
  >`SELECT merged_at, merged_commit_sha, merged_landing, merged_artifacts FROM issues WHERE id = ${id}`;
  return row;
}

const bodiesOn = async (id: string) =>
  (await m.sql<Array<{ body: string }>>`SELECT body FROM comments WHERE issue_id = ${id}`).map(
    (r) => r.body,
  );

describe('an approval decided before its landing was recorded', () => {
  it('stamps an unmarked git design issue at its first approval, naming that revision, with the notice', async () => {
    const p = await project('git');
    const id = await issue(p, 'on_hold');
    await workflow(p, 'catalog-context', [[3, id, FIRST]]);
    await workflow(p, 'epod-design-deploy', [[4, id, SECOND]]);

    await m.migrate();

    expect(await markOf(id)).toEqual({
      merged_at: FIRST,
      merged_commit_sha: null,
      merged_landing: null,
      merged_artifacts: [{ surface: 'design', ref: 'catalog-context@rev3', change: 'changed' }],
    });
    const [notice, ...more] = await bodiesOn(id);
    expect(more).toEqual([]);
    expect(notice).toContain(
      "Design `catalog-context` revision 3 was approved, and it is this issue's deliverable",
    );
    expect(notice).toContain('the mark is a timestamp and this notice names the revision');
    expect(notice).toContain(
      'decided at 2026-10-06 18:32Z, before an approval recorded its landing (ISS-262)',
    );
  });

  it('stamps an unmarked design issue outside git at its latest approval, naming its landing', async () => {
    const p = await project('storefront');
    const id = await issue(p, 'in_progress');
    await workflow(p, 'admin-data-flow', [[2, id, FIRST]]);
    await workflow(p, 'design-deploy', [[2, id, SECOND]]);

    await m.migrate();

    expect(await markOf(id)).toMatchObject({
      merged_at: SECOND,
      merged_landing: 'workflow design `design-deploy` revision 2, approved',
      merged_artifacts: [{ surface: 'design', ref: 'design-deploy@rev2', change: 'changed' }],
    });
    expect((await bodiesOn(id)).join('\n')).toContain(
      'Its landing now names the approved revision.',
    );
  });

  it('converges when run again: nothing is stamped or posted twice', async () => {
    const p = await project('git');
    const id = await issue(p);
    await workflow(p, 'system-context', [[4, id, FIRST]]);
    await m.migrate();
    const { readFileSync } = await import('node:fs');
    await m.sql.unsafe(
      readFileSync(new URL(`../../drizzle/migrations/${TAG}.sql`, import.meta.url), 'utf8'),
    );
    expect((await markOf(id))?.merged_at).toEqual(FIRST);
    expect(await bodiesOn(id)).toHaveLength(1);
  });
});

describe('what it leaves as it stands', () => {
  it('leaves a build issue, a marked issue, a dropped issue, an undeclared shape and a superseded drawing', async () => {
    const git = await project('git');
    const build = await issue(git, 'open');
    const tour = await workflow(git, 'tour', [[1, build, FIRST]]);
    await m.sql`INSERT INTO workflow_builds (issue_id, workflow_id, project_id, linked_by_user) VALUES (${build}, ${tour}, ${git}, ${userId})`;
    const observed = await issue(git, 'open', { at: SECOND, sha: 'a'.repeat(40) });
    const asserted = await issue(git, 'open', { at: SECOND });
    await workflow(git, 'observed-flow', [[1, observed, FIRST]]);
    await workflow(git, 'asserted-flow', [[1, asserted, FIRST]]);
    const dropped = await issue(git, 'dropped');
    await workflow(git, 'dropped-flow', [[1, dropped, FIRST]]);
    const bare = await project(null);
    const undeclared = await issue(bare, 'open');
    await workflow(bare, 'undeclared-flow', [[1, undeclared, FIRST]]);
    const superseded = await issue(git, 'open');
    const latest = await issue(git, 'awaiting_release');
    await workflow(git, 'moved-flow', [
      [1, superseded, FIRST],
      [2, latest, SECOND],
    ]);

    await m.migrate();

    for (const id of [build, dropped, undeclared, superseded]) {
      expect((await markOf(id))?.merged_at, id).toBeNull();
      expect(await bodiesOn(id)).toEqual([]);
    }
    expect(await markOf(observed)).toMatchObject({
      merged_at: SECOND,
      merged_commit_sha: 'a'.repeat(40),
      merged_artifacts: null,
    });
    expect(await markOf(asserted)).toMatchObject({ merged_at: SECOND, merged_artifacts: null });
    expect(await bodiesOn(observed)).toEqual([]);
    expect(await markOf(latest)).toMatchObject({
      merged_at: SECOND,
      merged_artifacts: [{ surface: 'design', ref: 'moved-flow@rev2', change: 'changed' }],
    });
  });
});

describe('a shape it cannot read', () => {
  it('aborts naming the issue whose project stores a source type no schema admits, and stamps nothing', async () => {
    const odd = await project('svn');
    const id = await issue(odd);
    await workflow(odd, 'odd-flow', [[1, id, FIRST]]);
    const git = await project('git');
    const fine = await issue(git);
    await workflow(git, 'fine-flow', [[1, fine, FIRST]]);

    let refusal = '';
    try {
      await m.migrate();
    } catch (e) {
      const err = e as Error & { cause?: { message?: string } };
      refusal = `${err.message} ${err.cause?.message ?? ''}`;
    }
    expect(refusal).toMatch(
      new RegExp(`DESIGN_LANDING_SHAPE_UNKNOWN: .*\\(${id}\\): source.type \`svn\``),
    );
    expect((await markOf(fine))?.merged_at).toBeNull();
  });
});
