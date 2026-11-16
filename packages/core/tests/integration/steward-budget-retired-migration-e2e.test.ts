/**
 * Migration 0664 (ISS-1255), run by drizzle's own migrator over project documents written while the
 * steward had a daily budget: each `steward.budget` is stripped as a revision Forge writes itself and
 * named in a NOTICE, a budget of no turns and no jobs turns the steward off rather than on, and a
 * document without a budget is left exactly as it was.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0664_the_steward_budget_is_retired';

let ground: MigrationGround;
let m: MigrationDb;
let userId: string;
let orgId: string;

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

/** A project holding `extra` in its document at revision 4, last written by the person. */
async function projectWith(slug: string, extra: Record<string, unknown>) {
  const id = randomUUID();
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${id}, ${slug}, 'P', ${orgId}, ${userId})`;
  const document = { version: 1, project: { id, slug, name: 'P' }, ...extra };
  await m.sql`
    INSERT INTO project_config_documents (project_id, revision, document, updated_by, updated_at)
    VALUES (${id}, 4, ${m.sql.json(document)}, ${userId}, '2026-11-01T00:00:00Z')`;
  return { id, document };
}

async function stored(id: string) {
  const [row] = await m.sql<
    Array<{ revision: number; document: Record<string, unknown>; updated_by: string | null }>
  >`SELECT revision, document, updated_by FROM project_config_documents WHERE project_id = ${id}`;
  return row;
}

describe('a project document written while the steward had a daily budget', () => {
  it('loses the budget as a revision Forge writes, keeps enabled, and names every document in the NOTICE', async () => {
    const lowered = await projectWith('lowered', {
      steward: { enabled: true, budget: { runnerJobs: 3 } },
    });
    const bare = await projectWith('bare', { steward: { budget: { gatewayTurns: 50 } } });
    const notices: string[] = [];
    await m.migrate((n) => notices.push(n));

    const one = await stored(lowered.id);
    expect(one).toMatchObject({ revision: 5, updated_by: null });
    expect(one?.document.steward).toEqual({ enabled: true });
    // a steward key the strip leaves empty goes with it: absent is on, as it read before
    const two = await stored(bare.id);
    expect(two?.revision).toBe(5);
    expect(two?.document).not.toHaveProperty('steward');

    const notice = notices.find((n) => n.startsWith('0664:'));
    expect(notice).toContain('2 project document(s)');
    expect(notice).toContain(`lowered (${lowered.id}): steward.budget {"runnerJobs": 3} stripped`);
    expect(notice).toContain(`bare (${bare.id}): steward.budget {"gatewayTurns": 50} stripped`);
  });

  it('turns off a steward whose budget let it do nothing, rather than switching it on', async () => {
    const zero = await projectWith('zero', {
      steward: { enabled: true, budget: { gatewayTurns: 0, runnerJobs: 0 } },
    });
    const notices: string[] = [];
    await m.migrate((n) => notices.push(n));
    expect((await stored(zero.id))?.document.steward).toEqual({ enabled: false });
    expect(notices.join('\n')).toContain('steward.enabled set false');
  });

  it('leaves a document without a budget exactly as it was', async () => {
    const plain = await projectWith('plain', { steward: { enabled: false } });
    const none = await projectWith('none', {});
    const before = await Promise.all([plain.id, none.id].map(stored));
    const notices: string[] = [];
    await m.migrate((n) => notices.push(n));
    expect(await Promise.all([plain.id, none.id].map(stored))).toEqual(before);
    expect(notices.find((n) => n.startsWith('0664:'))).toContain('0 project document(s)');
  });
});
