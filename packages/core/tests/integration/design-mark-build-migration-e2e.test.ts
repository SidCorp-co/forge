/**
 * Migration 0435, run by drizzle's own migrator over the rows a design approval left: the merged mark
 * it wrote on an issue linked as the build of a workflow is cleared, with a notice saying why; a design
 * issue's mark, another writer's mark and a released issue's mark stay; and a row whose mark it cannot
 * attribute aborts the deploy naming it.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0435_a_design_approval_does_not_land_a_build';
const STAMP = new Date('2026-10-07T02:12:37.455Z');

let ground: MigrationGround;
let m: MigrationDb;
let userId: string;
let projectId: string;
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
  projectId = randomUUID();
  const orgId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`hop-${projectId.slice(0, 8)}`}, 'P', ${orgId}, ${userId})`;
});

afterEach(async () => {
  await m.drop();
});

const sentence = (flow: string) => `workflow design \`${flow}\` revision 1, approved`;
const notice = (flow: string) =>
  `Design \`${flow}\` revision 1 was approved, and it is this issue's deliverable, so this issue's merged mark now records it. Its landing now names the approved revision.`;

async function workflow(flow: string): Promise<string> {
  const id = randomUUID();
  await m.sql`
    INSERT INTO project_workflows (id, project_id, flow, kind, revision, document, design_status, approved_revision, written_by_user)
    VALUES (${id}, ${projectId}, ${flow}, 'flow', 1, '{}'::jsonb, 'approved', 1, ${userId})
  `;
  return id;
}

/** An issue at `status` carrying `landing` stamped at STAMP, drawing an approved revision of `drawn`. */
async function plant(args: {
  status: string;
  drawn: string;
  landing: string | null;
  builds?: string;
  notice?: boolean;
  target?: string;
}): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await m.sql.begin(async (tx) => {
    await tx`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`;
    await tx`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at, merged_landing, merged_target)
      VALUES (${id}, ${projectId}, ${seq}, 'planted', ${args.status}, ${userId}, ${STAMP}, ${args.landing}, ${args.target ?? null})
    `;
  });
  const drawnId = await workflow(`${args.drawn}-${seq}`);
  await m.sql`
    INSERT INTO project_workflow_designs (workflow_id, revision, document, proposed_by_user, decision, decided_by_user, decided_at, design_issue_id)
    VALUES (${drawnId}, 1, '{}'::jsonb, ${userId}, 'approve', ${userId}, ${STAMP}, ${id})
  `;
  if (args.builds) {
    const builtId = await workflow(`${args.builds}-${seq}`);
    await m.sql`
      INSERT INTO workflow_builds (issue_id, workflow_id, project_id, linked_by_user)
      VALUES (${id}, ${builtId}, ${projectId}, ${userId})
    `;
  }
  if (args.notice !== false) {
    await m.sql`
      INSERT INTO comments (issue_id, author_id, body, created_at)
      VALUES (${id}, ${userId}, ${notice(args.drawn)}, ${STAMP})
    `;
  }
  return id;
}

async function markOf(id: string) {
  const [row] = await m.sql<
    Array<{ merged_at: Date | null; merged_landing: string | null; merged_artifacts: unknown }>
  >`SELECT merged_at, merged_landing, merged_artifacts FROM issues WHERE id = ${id}`;
  return row;
}

/** What the deploy's migrator refused with: the query error drizzle wraps carries the database's words. */
async function refusalOf(): Promise<string | null> {
  try {
    await m.migrate();
  } catch (e) {
    const err = e as Error & { cause?: { message?: string } };
    return `${err.message} ${err.cause?.message ?? ''}`;
  }
  return null;
}

const bodiesOn = async (id: string) =>
  (await m.sql<Array<{ body: string }>>`SELECT body FROM comments WHERE issue_id = ${id}`).map(
    (r) => r.body,
  );

describe('a design approval mark on a build issue', () => {
  it('is cleared on an open build issue, with a notice naming the revision and the landing it held', async () => {
    const id = await plant({
      status: 'open',
      drawn: 'hop-attention-queue-ux',
      landing: sentence('hop-attention-queue-ux'),
      builds: 'hop-product-tour',
    });

    await m.migrate();

    expect(await markOf(id)).toMatchObject({
      merged_at: null,
      merged_landing: null,
      merged_artifacts: null,
    });
    const cleared = (await bodiesOn(id)).find((b) => b.includes('is cleared'));
    expect(cleared).toContain('the approval of design `hop-attention-queue-ux` revision 1');
    expect(cleared).toContain(`The mark read: ${sentence('hop-attention-queue-ux')}.`);
  });

  it('is cleared on a git build issue, whose mark names no landing, by the notice at its stamp', async () => {
    const id = await plant({
      status: 'in_progress',
      drawn: 'git-ux',
      landing: null,
      builds: 'git-tour',
    });
    await m.migrate();
    expect((await markOf(id))?.merged_at).toBeNull();
    expect((await bodiesOn(id)).join('\n')).toContain('a timestamp naming no landing');
  });
});

describe('the marks it leaves', () => {
  it("keeps a design issue's mark, a released build issue's mark, and a mark another writer made", async () => {
    const design = await plant({
      status: 'open',
      drawn: 'patient-360-ux',
      landing: sentence('patient-360-ux'),
    });
    const released = await plant({
      status: 'awaiting_release',
      drawn: 'released-ux',
      landing: sentence('released-ux'),
      builds: 'released-tour',
    });
    const own = await plant({
      status: 'open',
      drawn: 'own-ux',
      landing: 'hop Autoflow draft: the tour pages, built',
      builds: 'own-tour',
      notice: false,
    });

    await m.migrate();

    expect((await markOf(design))?.merged_landing).toBe(sentence('patient-360-ux'));
    expect((await markOf(released))?.merged_landing).toBe(sentence('released-ux'));
    expect((await markOf(own))?.merged_landing).toBe('hop Autoflow draft: the tour pages, built');
    for (const id of [design, released, own]) {
      expect((await bodiesOn(id)).join('\n')).not.toContain('is cleared');
    }
  });
});

describe('a row it cannot attribute', () => {
  it("aborts naming a build issue whose landing is the approval's sentence with no notice at its stamp, and clears nothing", async () => {
    const orphan = await plant({
      status: 'open',
      drawn: 'orphan-ux',
      landing: sentence('orphan-ux'),
      builds: 'orphan-tour',
      notice: false,
    });
    const clearable = await plant({
      status: 'open',
      drawn: 'clearable-ux',
      landing: sentence('clearable-ux'),
      builds: 'clearable-tour',
    });

    expect(await refusalOf()).toMatch(
      new RegExp(
        `DESIGN_MARK_UNCLASSIFIED: .*ISS-\\d+ \\(${orphan}\\): its landing is a design approval's sentence but no approval notice stands at its stamp`,
      ),
    );
    expect((await markOf(clearable))?.merged_landing).toBe(sentence('clearable-ux'));
  });

  it('aborts naming an approval mark something has since written a target onto', async () => {
    const id = await plant({
      status: 'open',
      drawn: 'targeted-ux',
      landing: null,
      builds: 'targeted-tour',
      target: 'dev',
    });
    expect(await refusalOf()).toMatch(
      new RegExp(`\\(${id}\\): the design approval's mark has since had paths, a target`),
    );
  });
});
