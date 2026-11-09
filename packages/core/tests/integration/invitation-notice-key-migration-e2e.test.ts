/**
 * Migration 0647, run by drizzle's own migrator over the notices the old code wrote (ISS-1188). An
 * `invitation_received` notice now counts only while the invitation its key names is pending; one
 * written before named none. 0647 names the newest older notice per invitation still pending, so that
 * invitation keeps counting once, and leaves every other older notice naming nothing, which is how
 * a stranded one stops counting.
 *
 * @direct-test-of packages/core/drizzle/migrations/0647_an_invitation_notice_names_its_invitation.sql
 */

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0647_an_invitation_notice_names_its_invitation';

let ground: MigrationGround;
let m: MigrationDb;
let inviter: string;
let projectId: string;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

async function user(db: postgres.Sql): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `${id}@forge.test`;
  await db`INSERT INTO users (id, email, password_hash, kind) VALUES (${id}, ${email}, '!x', 'human')`;
  return { id, email };
}

/** A keyless notice, as the old code wrote one, delivered to `userId` at `at`. */
async function notice(db: postgres.Sql, userId: string, at: string): Promise<string> {
  const id = randomUUID();
  const delivery = randomUUID();
  await db`
    INSERT INTO notifications (id, project_id, type, kind, tier, state, title, severity, created_at)
    VALUES (${id}, ${projectId}, 'invitation_received', 'task', 'ticket', 'open', 'invited you', 'warning', ${at})`;
  await db`INSERT INTO notification_deliveries (id, user_id, created_at) VALUES (${delivery}, ${userId}, ${at})`;
  await db`INSERT INTO notification_delivery_members (delivery_id, notification_id) VALUES (${delivery}, ${id})`;
  return id;
}

async function invitation(
  db: postgres.Sql,
  email: string,
  state: { expiresIn: string; accepted?: boolean },
): Promise<string> {
  const ref = randomUUID().replaceAll('-', '');
  await db`
    INSERT INTO project_invitations (token_hash, project_id, email, role, inviter_id, expires_at, accepted_at)
    VALUES (${ref}, ${projectId}, ${email.toUpperCase()}, 'member', ${inviter},
            now() + ${state.expiresIn}::interval, ${state.accepted ? new Date().toISOString() : null})`;
  return ref;
}

async function keyOf(id: string): Promise<string | null> {
  const [row] = await m.sql<{ resolution_key: string | null }[]>`
    SELECT resolution_key FROM notifications WHERE id = ${id}`;
  return row?.resolution_key ?? null;
}

beforeEach(async () => {
  m = await ground.fresh();
  inviter = (await user(m.sql)).id;
  const orgId = randomUUID();
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${inviter})`;
  projectId = randomUUID();
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'Eco A', ${orgId}, ${inviter})`;
});

afterEach(async () => {
  await m.drop();
});

describe('0647 names an older invitation notice', () => {
  it('names the newest notice of an invitation still pending, and only that one', async () => {
    const invitee = await user(m.sql);
    const first = await notice(m.sql, invitee.id, '2026-10-04T00:00:00Z');
    const again = await notice(m.sql, invitee.id, '2026-10-08T00:00:00Z');
    const ref = await invitation(m.sql, invitee.email, { expiresIn: '3 days' });

    await m.migrate();

    expect(await keyOf(again)).toBe(`invitation:${ref}`);
    expect(await keyOf(first)).toBeNull();
  });

  it('leaves naming nothing a notice whose invitation expired or was accepted', async () => {
    const expiredTo = await user(m.sql);
    const expired = await notice(m.sql, expiredTo.id, '2026-10-04T00:00:00Z');
    await invitation(m.sql, expiredTo.email, { expiresIn: '-30 days' });
    const acceptedBy = await user(m.sql);
    const accepted = await notice(m.sql, acceptedBy.id, '2026-10-08T00:00:00Z');
    await invitation(m.sql, acceptedBy.email, { expiresIn: '3 days', accepted: true });

    await m.migrate();

    expect(await keyOf(expired)).toBeNull();
    expect(await keyOf(accepted)).toBeNull();
  });
});
