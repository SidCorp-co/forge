/**
 * ISS-1229 r21 — judge-60 at beta 7f539ee: deleting a project left its bell rows standing with their
 * titles while their notices went (beta held 748). A bell row now goes with the last notice it
 * holds, and migration 0346 removes the rows already left empty. In the same round, the master's
 * ruling: a personal workspace is never named by its owner's address.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import { createTestProject, createTestUser } from '../helpers/factories.js';
import { registerInboxFixture } from '../helpers/inbox-fixture.js';

const MIGRATION = fileURLToPath(
  new URL('../../drizzle/migrations/0346_a_bell_row_goes_with_its_notices.sql', import.meta.url),
);

const fx = registerInboxFixture();

async function runMigration(): Promise<string[]> {
  const notices: string[] = [];
  const postgres = (await import('postgres')).default;
  const client = postgres(process.env.DATABASE_URL ?? '', {
    max: 1,
    onnotice: (n) => notices.push(n.message ?? ''),
  });
  try {
    for (const statement of readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')) {
      if (statement.trim()) await client.unsafe(statement);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
  return notices.filter((n) => n.startsWith('0346'));
}

async function routes() {
  const { projectRoutes } = await import('../../src/projects/routes.js');
  const { meRoutes } = await import('../../src/auth/me.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  const app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', projectRoutes);
  app.route('/api/auth', meRoutes);
  app.onError(errorHandler);
  return app;
}

async function tell(projectId: string, title: string, groupKey?: string): Promise<string> {
  const told = await fx.mods.recordAndDeliver({
    type: 'mention',
    recipients: [fx.owner],
    projectId,
    title,
    ...(groupKey ? { groupKey, groupTitle: `Group ${groupKey}` } : {}),
  });
  if (!told) throw new Error(`nothing recorded for ${title}`);
  return told.id;
}

/** Every bell row the owner holds, with the titles of the notices it still holds. */
async function bell(): Promise<Array<{ title: string; holds: string[] }>> {
  const rows = (await fx.db.execute(sql`
    SELECT d.title,
           coalesce(array_agg(n.title ORDER BY n.title) FILTER (WHERE n.id IS NOT NULL), '{}') AS holds
      FROM notification_deliveries d
      LEFT JOIN notification_delivery_members m ON m.delivery_id = d.id
      LEFT JOIN notifications n ON n.id = m.notification_id
     WHERE d.user_id = ${fx.owner}
     GROUP BY d.id, d.title
     ORDER BY d.title
  `)) as unknown as Array<{ title: string; holds: string[] }>;
  return rows.map((r) => ({ title: r.title, holds: [...r.holds] }));
}

describe('a bell row goes with the last notice it holds', () => {
  it("deleting a project removes its bell rows and keeps a row that holds another project's notice", async () => {
    const other = await createTestProject(fx.db, fx.owner, { name: 'Ledger' });
    await tell(fx.project.id, 'Single');
    await tell(fx.project.id, 'Grouped one', 'g1');
    await tell(fx.project.id, 'Grouped two', 'g1');
    await tell(fx.project.id, 'Shared, ours', 'g2');
    await tell(other.id, 'Shared, theirs', 'g2');
    expect(await bell()).toHaveLength(3);

    const { signUserToken } = await import('../../src/auth/jwt.js');
    const res = await (await routes()).request(`/api/projects/${fx.project.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await signUserToken(fx.owner)}` },
    });
    expect(res.status, await res.clone().text()).toBe(204);

    expect(await bell()).toEqual([{ title: 'Group g2', holds: ['Ledger — Shared, theirs'] }]);
  });

  it('any removal of notices removes the bell rows it leaves holding none', async () => {
    const single = await tell(fx.project.id, 'Single');
    const one = await tell(fx.project.id, 'Grouped one', 'g1');
    await tell(fx.project.id, 'Grouped two', 'g1');

    await fx.db.execute(sql`DELETE FROM notifications WHERE id IN (${single}, ${one})`);

    expect(await bell()).toEqual([{ title: 'Group g1', holds: ['Invoicing — Grouped two'] }]);
  });

  it('a bell row and its first member land together: a member that cannot be written leaves no row', async () => {
    await fx.db.execute(sql`
      CREATE FUNCTION refuse_member() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'member refused'; END $$
    `);
    await fx.db.execute(sql`
      CREATE TRIGGER refuse_member BEFORE INSERT ON notification_delivery_members
        FOR EACH ROW EXECUTE FUNCTION refuse_member()
    `);
    try {
      await expect(tell(fx.project.id, 'Never told')).rejects.toThrow();
      expect(await bell()).toEqual([]);
    } finally {
      await fx.db.execute(sql`DROP TRIGGER refuse_member ON notification_delivery_members`);
      await fx.db.execute(sql`DROP FUNCTION refuse_member()`);
    }
  });
});

async function owner(displayName: string | null, email: string): Promise<string> {
  const user = await createTestUser(fx.db, { email });
  await fx.db.execute(sql`
    UPDATE users SET display_name = ${displayName}, email_verified_at = now() WHERE id = ${user.id}
  `);
  return user.id;
}

async function personalWorkspace(userId: string, name: string): Promise<void> {
  await fx.db.execute(sql`
    INSERT INTO organizations (slug, name, is_personal, created_by)
    VALUES (${`personal-${userId}`}, ${name}, true, ${userId})
  `);
}

async function workspaceOf(userId: string): Promise<string | undefined> {
  const [row] = (await fx.db.execute(sql`
    SELECT name FROM organizations WHERE created_by = ${userId} AND is_personal
  `)) as unknown as Array<{ name: string }>;
  return row?.name;
}

describe('migration 0346', () => {
  it('removes the bell rows holding no notice, renames address-named workspaces, and counts both', async () => {
    await tell(fx.project.id, 'Held');
    await fx.db.execute(sql`
      INSERT INTO notification_deliveries (user_id, title) VALUES (${fx.owner}, '@lan.pham mentioned you')
    `);
    const unnamed = await owner(null, 'lan.pham@example.com');
    const named = await owner('  Mai Tran ', 'mai@example.com');
    const addressNamed = await owner('self@example.com', 'self@example.com');
    const handNamed = await owner(null, 'kim@example.com');
    const ownLocalPart = await owner('Ha', 'ha@example.com');
    await personalWorkspace(unnamed, 'lan.pham');
    await personalWorkspace(named, 'mai');
    await personalWorkspace(addressNamed, 'personal');
    await personalWorkspace(handNamed, 'Kim sandbox');
    await personalWorkspace(ownLocalPart, 'ha');

    expect(await runMigration()).toEqual([
      "0346: 1 bell row(s) holding no notice removed; 4 personal workspace(s) named by their owner's address renamed",
    ]);
    expect((await bell()).map((r) => r.holds)).toEqual([['Invoicing — Held']]);
    expect(await workspaceOf(unnamed)).toBe('Personal');
    expect(await workspaceOf(named)).toBe('Mai Tran');
    expect(await workspaceOf(addressNamed)).toBe('Personal');
    expect(await workspaceOf(handNamed)).toBe('Kim sandbox');
    expect(await workspaceOf(ownLocalPart)).toBe('Ha');

    expect(await runMigration()).toEqual([
      "0346: 0 bell row(s) holding no notice removed; 0 personal workspace(s) named by their owner's address renamed",
    ]);
  });
});

describe('a personal workspace is never named by its owner address', () => {
  it('a new account\'s personal workspace is named "Personal"', async () => {
    const { ensurePersonalOrg } = await import('../../src/orgs/service.js');
    const userId = await owner(null, 'new.person@example.com');
    const { db } = await import('../../src/db/client.js');
    await ensurePersonalOrg(db, userId);
    expect(await workspaceOf(userId)).toBe('Personal');
  });

  it('follows its owner display name, and a name its owner gave it stays', async () => {
    const { signUserToken } = await import('../../src/auth/jwt.js');
    const app = await routes();
    const userId = await owner(null, 'lan.pham@example.com');
    await personalWorkspace(userId, 'Personal');
    const setName = async (displayName: string | null) => {
      const res = await app.request('/api/auth/me', {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${await signUserToken(userId)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ displayName }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
    };

    await setName('Lan Pham');
    expect(await workspaceOf(userId)).toBe('Lan Pham');
    await setName('Lan P.');
    expect(await workspaceOf(userId)).toBe('Lan P.');
    await setName(null);
    expect(await workspaceOf(userId)).toBe('Personal');

    await fx.db.execute(
      sql`UPDATE organizations SET name = 'Lan sandbox' WHERE created_by = ${userId}`,
    );
    await setName('Lan Pham');
    expect(await workspaceOf(userId)).toBe('Lan sandbox');
  });
});
