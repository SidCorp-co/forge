/**
 * Migration 0551 (ISS-641, REQ-34 BC-3), run by drizzle's own migrator over rows written before
 * the readiness suggestion was retired: a `proposed` readiness suggestion, which no door accepts any
 * more, moves to `stale` with a reason naming the ready checklist and a `kernel_transitions` row;
 * every other readiness row (accepted, rejected) and a proposed suggestion of another kind stay as
 * they are, each with its payload, and no row is deleted.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0551_a_readiness_suggestion_is_retired';
const CHECKS = { checks: [{ check: 'has a scope', passed: false }] };

let ground: MigrationGround;
let m: MigrationDb;
let userId: string;
let projectId: string;
let requirementId: string;

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
  requirementId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'P', ${orgId}, ${userId})`;
  await m.sql`INSERT INTO requirements (id, project_id, req_seq, title, status) VALUES (${requirementId}, ${projectId}, 7, 'Boards keep their cards', 'draft')`;
});

afterEach(async () => {
  await m.drop();
});

async function suggestion(kind: string, status: 'proposed' | 'accepted' | 'rejected') {
  const id = randomUUID();
  const decided = status !== 'proposed';
  await m.sql.begin(async (tx) => {
    await tx`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`;
    await tx`
      INSERT INTO suggestions (id, project_id, kind, requirement_id, base_revision, payload, fingerprint, status, producer_kind, decided_by, decided_at, reason)
      VALUES (${id}, ${projectId}, ${kind}, ${requirementId}, 1, ${tx.json(CHECKS)}, ${id.slice(0, 32)}, ${status}, 'ba_assistant',
              ${decided ? userId : null}, ${decided ? new Date() : null}, ${status === 'rejected' ? 'not now' : null})
    `;
  });
  return id;
}

async function rowOf(id: string) {
  const [row] = await m.sql<
    Array<{ status: string; reason: string | null; decided_at: Date | null; payload: unknown }>
  >`SELECT status, reason, decided_at, payload FROM suggestions WHERE id = ${id}`;
  return row;
}

const movesOf = (id: string) =>
  m.sql<
    Array<{
      from_status: string;
      to_status: string;
      machine_version: number;
      actor_type: string;
      source: string;
    }>
  >`SELECT from_status, to_status, machine_version, actor_type, source FROM kernel_transitions WHERE entity = 'suggestion' AND entity_id = ${id}`;

describe('a readiness suggestion written before the retirement', () => {
  it('moves a proposed one to stale, naming the ready checklist, with its kernel transition and its payload kept', async () => {
    const id = await suggestion('readiness', 'proposed');
    await m.migrate();
    const row = await rowOf(id);
    expect(row?.status).toBe('stale');
    expect(row?.reason).toContain("the requirement's ready checklist decides readiness");
    expect(row?.reason).toContain('migration 0551');
    expect(row?.decided_at).not.toBeNull();
    expect(row?.payload).toEqual(CHECKS);
    expect(await movesOf(id)).toEqual([
      {
        from_status: 'proposed',
        to_status: 'stale',
        machine_version: 2,
        actor_type: 'system',
        source: 'migration',
      },
    ]);
  });

  it('leaves accepted and rejected readiness rows, and a proposed row of another kind, as they are', async () => {
    const accepted = await suggestion('readiness', 'accepted');
    const rejected = await suggestion('readiness', 'rejected');
    const other = await suggestion('duplicate', 'proposed');
    const before = await Promise.all([accepted, rejected, other].map(rowOf));
    await m.migrate();
    expect(await Promise.all([accepted, rejected, other].map(rowOf))).toEqual(before);
    for (const id of [accepted, rejected, other]) expect(await movesOf(id)).toEqual([]);
    const [count] = await m.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM suggestions`;
    expect(count?.n).toBe(3);
  });
});
