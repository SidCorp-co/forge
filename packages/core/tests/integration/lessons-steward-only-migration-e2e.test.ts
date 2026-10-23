/**
 * Migration 0522, run by drizzle's own migrator over the rows a deploy can find: a lesson-confusion
 * chat card still pending is settled declined for the steward with its reason, and the kind CHECK
 * then refuses a new pending one while a settled card stays; a lesson's `kept_at` later than its other
 * clock columns is folded into `last_applied_at`, so its unused clock does not move; a correction a
 * person dismissed aborts the deploy by its id; a confusion gains the steward's reason and `tried_at`.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0522_a_lesson_is_settled_by_its_steward_alone';

let ground: MigrationGround;
let m: MigrationDb;
let userId: string;
let stewardId: string;
let projectId: string;
let bareProjectId: string;
let conversationId: string;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

async function user(kind: 'human' | 'agent'): Promise<string> {
  const id = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${id}, ${`${id}@forge.test`}, '!x', ${kind})`;
  return id;
}

async function project(orgId: string): Promise<string> {
  const id = randomUUID();
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${id}, ${`p-${id.slice(0, 8)}`}, 'P', ${orgId}, ${userId})`;
  return id;
}

beforeEach(async () => {
  m = await ground.fresh();
  userId = await user('human');
  stewardId = await user('agent');
  const orgId = randomUUID();
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  projectId = await project(orgId);
  bareProjectId = await project(orgId);
  await m.sql`INSERT INTO steward_accounts (project_id, user_id) VALUES (${projectId}, ${stewardId})`;
  conversationId = randomUUID();
  await m.sql`INSERT INTO conversations (id, adapter, external_id) VALUES (${conversationId}, 'web', ${randomUUID()})`;
});

afterEach(async () => {
  await m.drop();
});

/** A held chat card, as a turn wrote it before 0522. */
async function card(
  project: string,
  kind: string,
  status: 'pending' | 'recorded' = 'pending',
): Promise<string> {
  const id = randomUUID();
  const settled = status === 'pending' ? null : new Date();
  const via = status === 'pending' ? null : 'card';
  await m.sql`
    INSERT INTO chat_proposals (id, project_id, conversation_id, proposed_to, kind, form, call, summary, status, agreed_via, decided_at)
    VALUES (${id}, ${project}, ${conversationId}, ${userId}, ${kind}, 'tool', ${m.sql.json({ name: 'x', arguments: {} })},
            ${m.sql.json({ title: 'A card' })}, ${status}, ${via}, ${settled})`;
  return id;
}

async function cardRow(id: string) {
  const [row] = await m.sql`
    SELECT status, decided_by, decided_at, failure, agreed_via FROM chat_proposals WHERE id = ${id}`;
  return row;
}

async function lesson(number: number, at: Record<'approved' | 'applied' | 'kept', string | null>) {
  const [row] = await m.sql`
    INSERT INTO lessons (project_id, number, sentence, scope_kind, status, proposed_by, proposed_agency, approved_at, last_applied_at, kept_at)
    VALUES (${projectId}, ${number}, ${`Lesson ${number}.`}, 'project', 'approved', ${stewardId}, 'agent',
            ${at.approved}::timestamptz, ${at.applied}::timestamptz, ${at.kept}::timestamptz)
    RETURNING id`;
  return row?.id as string;
}

async function lastApplied(id: string): Promise<string | null> {
  const [row] = await m.sql`SELECT last_applied_at FROM lessons WHERE id = ${id}`;
  return row?.last_applied_at ? (row.last_applied_at as Date).toISOString() : null;
}

async function columns(table: string): Promise<string[]> {
  const rows = await m.sql`
    SELECT column_name FROM information_schema.columns WHERE table_name = ${table} ORDER BY column_name`;
  return rows.map((r) => r.column_name as string);
}

describe('0522: chat cards of a lesson confusion', () => {
  it('settles each pending card declined for the steward with its reason, and keeps the rest', async () => {
    const withSteward = await card(projectId, 'lesson_confusion');
    const noSteward = await card(bareProjectId, 'lesson_confusion');
    const recorded = await card(projectId, 'lesson_confusion', 'recorded');
    const feedback = await card(projectId, 'feedback');
    await m.migrate();
    expect(await cardRow(withSteward)).toMatchObject({
      status: 'declined',
      decided_by: stewardId,
      agreed_via: null,
    });
    expect((await cardRow(withSteward))?.failure).toContain(
      'Settled by the steward at migration 0522',
    );
    expect(await cardRow(noSteward)).toMatchObject({ status: 'declined', decided_by: null });
    expect((await cardRow(noSteward))?.failure).toContain(
      'This project has no steward account yet',
    );
    expect(await cardRow(recorded)).toMatchObject({ status: 'recorded', failure: null });
    expect(await cardRow(feedback)).toMatchObject({ status: 'pending', decided_at: null });
  });

  it('refuses a new pending card of the kind, and admits a settled one', async () => {
    await m.migrate();
    const refused = await card(projectId, 'lesson_confusion').then(
      () => null,
      (err: unknown) => err as { code?: string; constraint_name?: string },
    );
    expect(refused?.code).toBe('23514');
    expect(refused?.constraint_name).toBe('chat_proposals_kind_chk');
    await card(projectId, 'lesson_confusion', 'recorded');
    await card(projectId, 'feedback');
  });
});

describe('0522: lesson columns no code writes', () => {
  it('folds a later kept_at into last_applied_at, names it, and drops the three columns', async () => {
    const kept = await lesson(1, {
      approved: '2026-07-01T00:00:00Z',
      applied: '2026-07-10T00:00:00Z',
      kept: '2026-09-01T00:00:00Z',
    });
    const keptNeverApplied = await lesson(2, {
      approved: '2026-07-01T00:00:00Z',
      applied: null,
      kept: '2026-08-01T00:00:00Z',
    });
    const earlier = await lesson(3, {
      approved: '2026-07-01T00:00:00Z',
      applied: '2026-09-15T00:00:00Z',
      kept: '2026-08-01T00:00:00Z',
    });
    const notices: string[] = [];
    await m.migrate((n) => notices.push(n));
    expect(await lastApplied(kept)).toBe('2026-09-01T00:00:00.000Z');
    expect(await lastApplied(keptNeverApplied)).toBe('2026-08-01T00:00:00.000Z');
    expect(await lastApplied(earlier)).toBe('2026-09-15T00:00:00.000Z');
    const folded = notices.filter((n) => n.startsWith('0522: L-'));
    expect(folded).toHaveLength(2);
    expect(folded[0]).toContain(`lesson ${kept}`);
    const lessonColumns = await columns('lessons');
    for (const gone of ['kept_at', 'retire_reason', 'retire_proposed_at']) {
      expect(lessonColumns).not.toContain(gone);
    }
  });

  it('gives a confusion the steward reason and tried_at, and a correction no dismissal', async () => {
    await m.migrate();
    expect(await columns('lesson_confusions')).toEqual(
      expect.arrayContaining(['reason', 'tried_at']),
    );
    const correctionColumns = await columns('corrections');
    expect(correctionColumns).not.toContain('dismissed_at');
    expect(correctionColumns).not.toContain('dismissed_by');
    const [idx] =
      await m.sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'corrections_unlinked_idx'`;
    expect(idx?.indexdef).toMatch(/WHERE \(lesson_id IS NULL\)$/);
  });

  it('aborts the deploy naming a correction a person dismissed, and changes nothing', async () => {
    const pending = await card(projectId, 'lesson_confusion');
    const id = randomUUID();
    await m.sql`
      INSERT INTO corrections (id, project_id, source, source_ref, item_kind, item_id, item_key, reason, agency, dismissed_at, dismissed_by)
      VALUES (${id}, ${projectId}, 'suggestion_rejected', ${randomUUID()}, 'suggestion', ${randomUUID()}, 'S-1', 'Wrong ward.', 'human', now(), ${userId})`;
    const refused = await m.migrate().then(
      () => 'applied',
      (e: unknown) => {
        // drizzle carries the database's own message as the cause
        const err = e as Error & { cause?: { message?: string } };
        return `${err.message} ${err.cause?.message ?? ''}`;
      },
    );
    expect(refused).toContain(
      `0522: corrections a person dismissed, which the schema without dismissed_at cannot represent (each would feed a lesson again): ${id} (project ${projectId})`,
    );
    expect(await cardRow(pending)).toMatchObject({ status: 'pending' });
    expect(await columns('corrections')).toContain('dismissed_at');
  });
});
