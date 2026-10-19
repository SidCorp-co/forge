/**
 * ISS-1229 r18 — judge-48 at beta 02b2026: a member with no display name was named by their email
 * address in notice titles and the bell. The master's ruling: a notice, bell row or page never shows
 * an address as a person's name. Covered here: the delivery door, an invitation from an inviter with
 * no display name, and migration 0342 over titles already stored — its own text read from its file,
 * so what is proved is what runs at the deploy. Every case ends by refusing any stored title that
 * still carries an address.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ADDRESS_PATTERN } from '../../src/lib/person-name.js';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import { createTestUser } from '../helpers/factories.js';
import { registerInboxFixture } from '../helpers/inbox-fixture.js';

vi.mock('../../src/projects/invitation-email.js', () => ({
  sendInvitationEmail: async () => undefined,
  sendOrgInvitationEmail: async () => undefined,
}));

const MIGRATION = fileURLToPath(
  new URL('../../drizzle/migrations/0342_a_notice_names_no_one_by_address.sql', import.meta.url),
);

const fx = registerInboxFixture();
let app: Hono<{ Variables: RequestIdVars }>;

beforeAll(async () => {
  const { memberRoutes } = await import('../../src/projects/members-routes.js');
  const { invitationRoutes } = await import('../../src/projects/invitations-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', memberRoutes);
  app.route('/api/invitations', invitationRoutes);
  app.onError(errorHandler);
});

async function person(
  displayName: string | null,
  email?: string,
): Promise<{ id: string; email: string }> {
  const user = await createTestUser(fx.db, email ? { email } : {});
  await fx.db.execute(sql`
    UPDATE users SET display_name = ${displayName}, email_verified_at = now() WHERE id = ${user.id}
  `);
  return user;
}

async function addressedTitles(): Promise<string[]> {
  const rows = (await fx.db.execute(sql`
    SELECT title FROM notifications WHERE title ~ ${ADDRESS_PATTERN}
    UNION ALL
    SELECT title FROM notification_deliveries WHERE title ~ ${ADDRESS_PATTERN}
  `)) as unknown as Array<{ title: string }>;
  return rows.map((r) => r.title);
}

describe('a notice raised with an address in its title', () => {
  it("is stored with the person's name, or another member, in its place", async () => {
    const mai = await person('Mai');
    const lan = await person(null);
    await fx.mods.recordAndDeliver({
      type: 'mention',
      recipients: [fx.owner],
      projectId: fx.project.id,
      title: `${lan.email} and ${mai.email} asked about ${fx.project.name}`,
    });

    const [stored] = (await fx.db.execute(
      sql`SELECT title FROM notifications WHERE type = 'mention'`,
    )) as unknown as Array<{ title: string }>;
    expect(stored?.title).toBe(`Another member and Mai asked about ${fx.project.name}`);
    const [row] = (await fx.inbox()).items;
    expect(row?.title).toBe(stored?.title);
    expect(await addressedTitles()).toEqual([]);
  });
});

describe('an invitation from an inviter with no display name', () => {
  it('names them "Another member" in its notice and in the bell, never by address', async () => {
    const inviter = await person(null);
    const invitee = await person('Lan');
    await fx.db.execute(sql`
      INSERT INTO project_members (project_id, user_id, role) VALUES (${fx.project.id}, ${inviter.id}, 'admin')
    `);
    const { signUserToken } = await import('../../src/auth/jwt.js');
    const sent = await app.request(`/api/projects/${fx.project.id}/members/invite`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await signUserToken(inviter.id)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: invitee.email, role: 'member' }),
    });
    expect(sent.status, await sent.clone().text()).toBe(201);

    const [notice] = (await fx.db.execute(sql`
      SELECT title FROM notifications WHERE type = 'invitation_received'
    `)) as unknown as Array<{ title: string }>;
    expect(notice?.title).toBe(`Another member invited you to ${fx.project.name} as member`);

    const pending = await app.request('/api/invitations/pending', {
      headers: { authorization: `Bearer ${await signUserToken(invitee.id)}` },
    });
    expect(pending.status).toBe(200);
    const text = await pending.text();
    expect(text).not.toContain(inviter.email);
    expect(JSON.parse(text)).toMatchObject([{ inviterName: 'Another member', role: 'member' }]);
    expect(await addressedTitles()).toEqual([]);
  });
});

/** A record and the bell row that told it, both carrying `title`, as rows stored before round 18. */
async function stored(title: string): Promise<{ recordId: string; deliveryId: string }> {
  const [record] = (await fx.db.execute(sql`
    INSERT INTO notifications (type, kind, tier, state, title)
    VALUES ('issue_stranded', 'condition', 'ticket', 'firing', ${title})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [delivery] = (await fx.db.execute(sql`
    INSERT INTO notification_deliveries (user_id, title) VALUES (${fx.owner}, ${title}) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  await fx.db.execute(sql`
    INSERT INTO notification_delivery_members (delivery_id, notification_id)
    VALUES (${delivery?.id}, ${record?.id})
  `);
  return { recordId: record?.id ?? '', deliveryId: delivery?.id ?? '' };
}

async function titlesOf(ids: { recordId: string; deliveryId: string }) {
  const [r] = (await fx.db.execute(
    sql`SELECT title FROM notifications WHERE id = ${ids.recordId}`,
  )) as unknown as Array<{ title: string }>;
  const [d] = (await fx.db.execute(
    sql`SELECT title FROM notification_deliveries WHERE id = ${ids.deliveryId}`,
  )) as unknown as Array<{ title: string }>;
  return [r?.title, d?.title];
}

async function runMigration() {
  for (const statement of readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim()) await fx.db.execute(sql.raw(statement));
  }
}

describe('what core calls a person, in SQL as in TypeScript', () => {
  it.each([
    ['Mai', 'Mai'],
    ['  Mai\t', 'Mai'],
    ['\t\n', 'another member'],
    ['', 'another member'],
    [null, 'another member'],
    ['mai@example.com', 'another member'],
  ])('reads %j as %j, as personName does', async (given, called) => {
    const { personName, personNameSql } = await import('../../src/lib/person-name.js');
    const [row] = (await fx.db.execute(
      sql`SELECT ${personNameSql(sql`${given}::text`)} AS called`,
    )) as unknown as Array<{ called: string }>;
    expect(row?.called).toBe(called);
    expect(personName(given)).toBe(called);
  });
});

describe('migration 0342: a stored title names no one by address', () => {
  it('reads each address as that person is called now, on the record and its bell row', async () => {
    const mai = await person('Mai');
    const lan = await person(null);
    const selfNamed = await person('');
    await fx.db.execute(sql`UPDATE users SET display_name = email WHERE id = ${selfNamed.id}`);
    const blank = await person('\t\n');
    const padded = await person(' Lan\t');

    const named = await stored(
      `ISS-2 is waiting for ${mai.email.toUpperCase()}'s decision — Invoicing`,
    );
    const unnamed = await stored(`ISS-3 is waiting for ${lan.email}'s decision — Invoicing`);
    const opening = await stored(`${lan.email} invited you to Invoicing as member`);
    const addressAsName = await stored(
      `ISS-4 is waiting for something only ${selfNamed.email} can supply`,
    );
    const nobody = await stored('ISS-5 is waiting for ghost@departed.example — Invoicing');
    const twice = await stored(`${mai.email} and ${lan.email} and ${mai.email}`);
    const plain = await stored('ISS-6 moved to Testing');
    const spaces = await stored(`${blank.email} asked ${padded.email}`);
    expect((await addressedTitles()).length).toBe(14);

    await runMigration();

    expect(await titlesOf(named)).toEqual(
      Array(2).fill("ISS-2 is waiting for Mai's decision — Invoicing"),
    );
    expect(await titlesOf(unnamed)).toEqual(
      Array(2).fill("ISS-3 is waiting for another member's decision — Invoicing"),
    );
    expect(await titlesOf(opening)).toEqual(
      Array(2).fill('Another member invited you to Invoicing as member'),
    );
    expect(await titlesOf(addressAsName)).toEqual(
      Array(2).fill('ISS-4 is waiting for something only another member can supply'),
    );
    expect(await titlesOf(nobody)).toEqual(
      Array(2).fill('ISS-5 is waiting for another member — Invoicing'),
    );
    expect(await titlesOf(twice)).toEqual(Array(2).fill('Mai and another member and Mai'));
    expect(await titlesOf(plain)).toEqual(Array(2).fill('ISS-6 moved to Testing'));
    expect(await titlesOf(spaces)).toEqual(Array(2).fill('Another member asked Lan'));
    expect(await addressedTitles()).toEqual([]);
  });

  it('rewrites an address that sits inside another only where it stands on its own', async () => {
    await person('Mai', 'a@example.test');
    await person('Lan', 'ba@example.test');
    const nested = await stored('a@example.test and ba@example.test');
    await runMigration();
    expect(await titlesOf(nested)).toEqual(Array(2).fill('Mai and Lan'));
    await runMigration();
    expect(await titlesOf(nested)).toEqual(Array(2).fill('Mai and Lan'));
  });

  it('runs again over titles it already rewrote and changes nothing', async () => {
    const lan = await person(null);
    const once = await stored(`ISS-3 is waiting for ${lan.email}'s decision — Invoicing`);
    await runMigration();
    const after = await titlesOf(once);
    await runMigration();
    expect(await titlesOf(once)).toEqual(after);
  });
});
