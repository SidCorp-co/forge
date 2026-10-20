/**
 * ISS-1229 r18 — judge-48 at beta 02b2026: a member with no display name was named by their email
 * address in notice titles and the bell. The master's ruling: a notice, bell row or page never shows
 * an address as a person's name. ISS-1229 r19 — judge-54 at beta 907b85e: round 18 also rewrote an
 * address inside an issue's own title, so the bell disagreed with the issue page. The ruling: only the
 * slot that names a person is chosen by lib/person-name.ts; an issue title or project name is quoted
 * as written. Covered here: a title quoting an issue or project, an invitation from an inviter with no
 * display name, and migrations 0342 and 0343 over titles already stored — each read from its file, so
 * what is proved is what runs at the deploy. ISS-1229 r20 — judge-59 at beta 9974765: a mention named
 * who mentioned you by the part of their address before the "@". It now names them as personName
 * does, and migration 0344 rewrites the mentions already stored.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ADDRESS_PATTERN } from '../../src/lib/person-name.js';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import { createTestProject, createTestUser } from '../helpers/factories.js';
import { registerInboxFixture } from '../helpers/inbox-fixture.js';

vi.mock('../../src/projects/invitation-email.js', () => ({
  sendInvitationEmail: async () => undefined,
  sendOrgInvitationEmail: async () => undefined,
}));

const MIGRATION = fileURLToPath(
  new URL('../../drizzle/migrations/0342_a_notice_names_no_one_by_address.sql', import.meta.url),
);
const RESTORE = fileURLToPath(
  new URL('../../drizzle/migrations/0343_a_notice_quotes_a_title_as_written.sql', import.meta.url),
);
const MENTIONER = fileURLToPath(
  new URL('../../drizzle/migrations/0344_a_mention_names_who_mentioned_you.sql', import.meta.url),
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

async function issueTitled(seq: number, title: string): Promise<string> {
  const id = crypto.randomUUID();
  await fx.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, created_by_id, iss_seq)
    VALUES (${id}, ${fx.project.id}, ${title}, 'in_progress', ${fx.owner}, ${seq})
  `);
  return id;
}

describe('a notice title quoting an issue or a project', () => {
  it("shows the issue's title as written, an address in it included, stored and in the bell", async () => {
    const mai = await person('Mai');
    const actor = await person('Lan');
    const title = `Reply to ${mai.email} and refunds@example.com about the export`;
    const issueId = await issueTitled(4, title);
    const { HooksBus } = await import('../../src/pipeline/hooks.js');
    const { registerTransitionNotifications } = await import(
      '../../src/notifications/notify-transitions.js'
    );
    const bus = new HooksBus();
    registerTransitionNotifications(bus);
    await fx.db.execute(sql`UPDATE issues SET status = 'needs_info' WHERE id = ${issueId}`);
    await bus.emit('transition', {
      issueId,
      projectId: fx.project.id,
      actor: { type: 'user', id: actor.id, agency: 'human' },
      from: 'in_progress',
      to: 'needs_info',
      reopenCount: 0,
    });

    const [stored] = (await fx.db.execute(
      sql`SELECT title FROM notifications WHERE type = 'issue_status_changed'`,
    )) as unknown as Array<{ title: string }>;
    expect(stored?.title).toContain(title);
    const [row] = (await fx.inbox()).items;
    expect(row?.title).toBe(stored?.title);
  });

  it("shows a project's name as written, and a title opening with an address keeps it", async () => {
    await fx.db.execute(
      sql`UPDATE projects SET name = 'Billing (ops@example.com)' WHERE id = ${fx.project.id}`,
    );
    await fx.mods.recordAndDeliver({
      type: 'ops_alert',
      recipients: [fx.owner],
      projectId: fx.project.id,
      title: 'Billing (ops@example.com) — PM cadence auto-disabled',
    });
    await fx.mods.recordAndDeliver({
      type: 'mention',
      recipients: [fx.owner],
      projectId: fx.project.id,
      title: 'billing@example.com asked about Billing (ops@example.com)',
    });

    const titles = ((await fx.inbox()).items ?? []).map((r) => r.title).sort();
    expect(titles).toEqual([
      'Billing (ops@example.com) — PM cadence auto-disabled',
      'billing@example.com asked about Billing (ops@example.com)',
    ]);
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

/** A record about `about` and the bell row that told it, as 0342 left them. */
async function storedAbout(
  title: string,
  about: { issueId?: string; projectId?: string },
  deliveryTitle: string = title,
): Promise<{ recordId: string; deliveryId: string }> {
  const [record] = (await fx.db.execute(sql`
    INSERT INTO notifications (type, kind, tier, state, title, issue_id, project_id)
    VALUES ('issue_stranded', 'condition', 'ticket', 'firing', ${title},
            ${about.issueId ?? null}, ${about.projectId ?? null})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [delivery] = (await fx.db.execute(sql`
    INSERT INTO notification_deliveries (user_id, title) VALUES (${fx.owner}, ${deliveryTitle}) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  await fx.db.execute(sql`
    INSERT INTO notification_delivery_members (delivery_id, notification_id)
    VALUES (${delivery?.id}, ${record?.id})
  `);
  return { recordId: record?.id ?? '', deliveryId: delivery?.id ?? '' };
}

async function runRestore(file: string = RESTORE): Promise<string[]> {
  const notices: string[] = [];
  const postgres = (await import('postgres')).default;
  const client = postgres(process.env.DATABASE_URL ?? '', {
    max: 1,
    onnotice: (n) => notices.push(n.message ?? ''),
  });
  try {
    for (const statement of readFileSync(file, 'utf8').split('--> statement-breakpoint')) {
      if (statement.trim()) await client.unsafe(statement);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
  return notices;
}

describe("migration 0343: a stored title quotes its issue's title and its project's name as written", () => {
  it('restores what 0342 read as a person inside an issue title or a project name', async () => {
    const mai = await person('Mai');
    await person(null, 'lan@example.com');
    const quoted = `Reply to ${mai.email} about the export`;
    const exportIssue = await issueTitled(1, quoted);
    const retitled = await issueTitled(3, `Send ${mai.email} the export`);
    const plainIssue = await issueTitled(5, 'Fix the export');
    await fx.db.execute(
      sql`UPDATE projects SET name = 'Billing (ops@example.com)' WHERE id = ${fx.project.id}`,
    );

    const moved = await storedAbout('ISS-1 — Reply to Mai about the export moved to Needs info', {
      issueId: exportIssue,
    });
    const mention = await storedAbout('@lan mentioned you in "Reply to Mai about the export"', {
      issueId: exportIssue,
    });
    const resolved = await storedAbout(
      'ISS-1 — Reply to Mai about the export moved to Needs info',
      { issueId: exportIssue },
      'Resolved — ISS-1 — Reply to Mai about the export moved to Needs info',
    );
    const desk = await createTestProject(fx.db, fx.owner, { name: 'lan@example.com desk' });
    const atStart = await storedAbout('Another member desk — PM cadence auto-disabled', {
      projectId: desk.id,
    });
    const project = await storedAbout('Billing (another member) — PM cadence auto-disabled', {
      projectId: fx.project.id,
    });
    const stale = await storedAbout(
      'ISS-3 — Reply to another member about the export moved to Needs info',
      { issueId: retitled },
    );
    const park = await storedAbout("ISS-5 is waiting for another member's decision — Invoicing", {
      issueId: plainIssue,
    });

    // Consult fc2554 findings F1 and F2: a whole-address title, and a person slot reading like one.
    const bare = await person('Mai', 'Mai@desk.example.com');
    const bareIssue = await issueTitled(6, bare.email);
    const whole = await storedAbout('ISS-6 — Mai moved to Needs info', { issueId: bareIssue });
    const addressOnly = await issueTitled(7, 'ops-desk@example.com');
    const slot = await storedAbout("ISS-7 is waiting for another member's decision — Invoicing", {
      issueId: addressOnly,
    });

    // Consult 708806 F1: a person read as a status's own words is no quoted title.
    const statusNamed = await person('Needs info', 'desk@status.example.com');
    const statusIssue = await issueTitled(8, statusNamed.email);
    const transition = await storedAbout('ISS-8 — Needs info moved to Needs info', {
      issueId: statusIssue,
    });

    // Consult 1641f0 F1: a person named like the project is not the project's place.
    const projectNamed = await person('Invoicing', 'books@desk.example.com');
    const projectLike = await issueTitled(9, projectNamed.email);
    const suffix = await storedAbout("ISS-9 is waiting for another member's decision — Invoicing", {
      issueId: projectLike,
    });

    // Consult 8b8298 F1: a project's name read like words inside an issue's title is not its place.
    const ledger = await createTestProject(fx.db, fx.owner, { name: 'books@ledger.example.com' });
    await person('Invoicing', 'books@ledger.example.com');
    const guideIssue = await issueTitled(10, 'Guide to Invoicing as owner');
    const guide = await storedAbout('ISS-10 — Guide to Invoicing as owner moved to Needs info', {
      issueId: guideIssue,
      projectId: ledger.id,
    });

    const notices = await runRestore();

    expect(await titlesOf(guide)).toEqual(
      Array(2).fill('ISS-10 — Guide to Invoicing as owner moved to Needs info'),
    );

    expect(await titlesOf(suffix)).toEqual(
      Array(2).fill("ISS-9 is waiting for another member's decision — Invoicing"),
    );

    expect(await titlesOf(transition)).toEqual(
      Array(2).fill(`ISS-8 — ${statusNamed.email} moved to Needs info`),
    );

    expect(await titlesOf(whole)).toEqual(
      Array(2).fill(`ISS-6 — ${bare.email} moved to Needs info`),
    );
    expect(await titlesOf(slot)).toEqual(
      Array(2).fill("ISS-7 is waiting for another member's decision — Invoicing"),
    );

    expect(await titlesOf(moved)).toEqual(Array(2).fill(`ISS-1 — ${quoted} moved to Needs info`));
    expect(await titlesOf(mention)).toEqual(Array(2).fill(`@lan mentioned you in "${quoted}"`));
    expect(await titlesOf(resolved)).toEqual([
      `ISS-1 — ${quoted} moved to Needs info`,
      `Resolved — ISS-1 — ${quoted} moved to Needs info`,
    ]);
    expect(await titlesOf(atStart)).toEqual(
      Array(2).fill('lan@example.com desk — PM cadence auto-disabled'),
    );
    expect(await titlesOf(project)).toEqual(
      Array(2).fill('Billing (ops@example.com) — PM cadence auto-disabled'),
    );
    expect(await titlesOf(stale)).toEqual(
      Array(2).fill('ISS-3 — Reply to another member about the export moved to Needs info'),
    );
    expect(await titlesOf(park)).toEqual(
      Array(2).fill("ISS-5 is waiting for another member's decision — Invoicing"),
    );
    expect(notices).toEqual([
      "0343: 14 stored title(s) quote an issue title or project name as written again; 8 that quote neither that text nor 0342's reading of it were left as they are",
    ]);
  });

  // Consults f0e175 and 2d5735: titles as their producers and the door store them, then 0342.
  it('restores a mention and an intake notice as the delivery door stored them', async () => {
    await person('Lan', 'lan.handle@example.com');
    const quoted = 'Refund ops@desk.example.com moved to Closed';
    const issueId = await issueTitled(11, quoted);
    // The mention as round 19's producer wrote it, which is what 0342 and 0343 ran over.
    await fx.mods.recordAndDeliver({
      type: 'mention',
      recipients: [fx.owner],
      projectId: fx.project.id,
      issueId,
      title: `@lan.handle mentioned you in "${quoted}"`,
    });
    await fx.mods.recordAndDeliver({
      type: 'intake_pending',
      recipients: [fx.owner],
      projectId: fx.project.id,
      issueId,
      title: `Awaiting intake review: ${quoted}`,
    });
    const asStored = async () =>
      (
        (await fx.db.execute(
          sql`SELECT title FROM notifications WHERE issue_id = ${issueId}`,
        )) as unknown as Array<{ title: string }>
      )
        .map((r) => r.title)
        .sort();
    const produced = [
      `ISS-11 — @lan.handle mentioned you in "${quoted}"`,
      `ISS-11 — Awaiting intake review: ${quoted}`,
    ].sort();
    expect(await asStored()).toEqual(produced);

    await runMigration();
    expect((await asStored()).every((t) => t.includes('another member'))).toBe(true);
    await runRestore();
    expect(await asStored()).toEqual(produced);
  });

  it('runs again over titles it already restored and changes nothing', async () => {
    const mai = await person('Mai');
    const issueId = await issueTitled(1, `Reply to ${mai.email}`);
    const once = await storedAbout('ISS-1 — Reply to Mai moved to Needs info', { issueId });
    await runRestore();
    const after = await titlesOf(once);
    expect(after).toEqual(Array(2).fill(`ISS-1 — Reply to ${mai.email} moved to Needs info`));
    await runRestore();
    expect(await titlesOf(once)).toEqual(after);
  });
});

async function mentionBy(mentioner: { id: string }, issueId: string): Promise<void> {
  const { HooksBus } = await import('../../src/pipeline/hooks.js');
  const { registerNotifyMentionsSubscriber } = await import(
    '../../src/notifications/notify-mentions.js'
  );
  const bus = new HooksBus();
  registerNotifyMentionsSubscriber(bus);
  await bus.emit('commentMentioned', {
    issueId,
    projectId: fx.project.id,
    commentId: crypto.randomUUID(),
    actor: { type: 'user', id: mentioner.id, agency: 'human' },
    mentionedUserIds: [fx.owner],
  });
}

async function mentionTitles(issueId: string): Promise<string[]> {
  const rows = (await fx.db.execute(sql`
    SELECT n.title FROM notifications n WHERE n.issue_id = ${issueId}
    UNION ALL
    SELECT d.title FROM notification_deliveries d
      JOIN notification_delivery_members m ON m.delivery_id = d.id
      JOIN notifications n ON n.id = m.notification_id
     WHERE n.issue_id = ${issueId}
  `)) as unknown as Array<{ title: string }>;
  return rows.map((r) => r.title);
}

describe('a mention names who mentioned you as core calls them', () => {
  it.each([
    ['Lan Pham', 'Lan Pham'],
    [null, 'Another member'],
    ['   ', 'Another member'],
    ['lan.pham@example.com', 'Another member'],
  ])('a mentioner whose display name is %j reads %j, stored and in the bell', async (given, called) => {
    const mentioner = await person(given, 'lan.pham@example.com');
    const issueId = await issueTitled(7, 'Fix the export');
    await mentionBy(mentioner, issueId);

    const expected = `ISS-7 — ${called} mentioned you in "Fix the export"`;
    expect(await mentionTitles(issueId)).toEqual([expected, expected]);
    const [row] = (await fx.inbox()).items;
    expect(row?.title).toBe(expected);
    expect(row?.title).not.toContain('lan.pham');
  });
});

/** Two comment rows give an author a hand on an issue, which is how 0344 tells two alike handles apart. */
async function commentOn(issueId: string, authorId: string): Promise<void> {
  await fx.db.execute(sql`
    INSERT INTO comments (issue_id, author_id, body) VALUES (${issueId}, ${authorId}, 'see @someone')
  `);
}

async function storedMention(issueId: string, title: string) {
  await fx.mods.recordAndDeliver({
    type: 'mention',
    recipients: [fx.owner],
    projectId: fx.project.id,
    issueId,
    title,
  });
}

describe('migration 0344: a stored mention names who mentioned you as core calls them', () => {
  it('rewrites each "@handle" it can tie to one person, and leaves and counts the rest', async () => {
    await person('Lan Pham', 'lan.pham@example.com');
    await person(null, 'mai@example.com');
    await person(null, 'self.named@example.com').then((u) =>
      fx.db.execute(sql`UPDATE users SET display_name = email WHERE id = ${u.id}`),
    );
    const twinA = await person('Twin A', 'twin@a.example');
    await person('Twin B', 'twin@b.example');
    await person('Solo', 'solo@c.example');

    const named = await issueTitled(1, 'Fix the export');
    const unnamed = await issueTitled(2, 'Fix the import');
    const addressAsName = await issueTitled(3, 'Fix the "quoted" rows');
    const twins = await issueTitled(4, 'Ask the twins');
    const twinsUnknown = await issueTitled(5, 'Ask nobody');
    const nobody = await issueTitled(6, 'Ghost');
    const someone = await issueTitled(8, 'Lost actor');
    const done = await issueTitled(9, 'Already named');
    const caseOnly = await issueTitled(10, 'Case matters');
    await commentOn(twins, twinA.id);

    await storedMention(named, '@lan.pham mentioned you in "Fix the export"');
    await storedMention(unnamed, '@mai mentioned you in "Fix the import"');
    await storedMention(addressAsName, '@self.named mentioned you in "Fix the "quoted" rows"');
    await storedMention(twins, '@twin mentioned you in "Ask the twins"');
    await storedMention(twinsUnknown, '@twin mentioned you in "Ask nobody"');
    await storedMention(nobody, '@ghost mentioned you in "Ghost"');
    await storedMention(someone, 'someone mentioned you in "Lost actor"');
    await storedMention(done, 'Lan Pham mentioned you in "Already named"');
    await storedMention(caseOnly, '@SOLO mentioned you in "Case matters"');
    await fx.mods.recordAndDeliver({
      type: 'ops_alert',
      recipients: [fx.owner],
      projectId: fx.project.id,
      issueId: nobody,
      title: '@solo mentioned you in "not a mention"',
    });

    const notices = await runRestore(MENTIONER);

    const both = (t: string) => [t, t];
    expect(await mentionTitles(named)).toEqual(both('ISS-1 — Lan Pham mentioned you in "Fix the export"'));
    expect(await mentionTitles(unnamed)).toEqual(
      both('ISS-2 — Another member mentioned you in "Fix the import"'),
    );
    expect(await mentionTitles(addressAsName)).toEqual(
      both('ISS-3 — Another member mentioned you in "Fix the "quoted" rows"'),
    );
    expect(await mentionTitles(twins)).toEqual(both('ISS-4 — Twin A mentioned you in "Ask the twins"'));
    expect(await mentionTitles(twinsUnknown)).toEqual(
      both('ISS-5 — @twin mentioned you in "Ask nobody"'),
    );
    expect((await mentionTitles(nobody)).sort()).toEqual(
      [
        'ISS-6 — @ghost mentioned you in "Ghost"',
        'ISS-6 — @ghost mentioned you in "Ghost"',
        'ISS-6 — @solo mentioned you in "not a mention"',
        'ISS-6 — @solo mentioned you in "not a mention"',
      ].sort(),
    );
    expect(await mentionTitles(someone)).toEqual(
      both('ISS-8 — Another member mentioned you in "Lost actor"'),
    );
    expect(await mentionTitles(done)).toEqual(both('ISS-9 — Lan Pham mentioned you in "Already named"'));
    expect(await mentionTitles(caseOnly)).toEqual(both('ISS-10 — @SOLO mentioned you in "Case matters"'));
    expect(notices).toEqual([
      '0344: 10 stored mention title(s) now name who mentioned the reader as core calls them; 6 whose handle names no one person were left as they are',
    ]);
  });

  // Consult on the round-20 diff: a display name may itself read like a handle or "someone".
  it('leaves a token somebody is called by, so a name it wrote is never read as a handle', async () => {
    await person('@solo', 'lan@example.com');
    await person('Solo', 'solo@example.com');
    await person('someone', 'some.one@example.com');
    const fix = await issueTitled(1, 'Fix');
    const named = await issueTitled(2, 'Named');
    await storedMention(fix, '@lan mentioned you in "Fix"');
    await storedMention(named, 'someone mentioned you in "Named"');

    const first = await runRestore(MENTIONER);
    const second = await runRestore(MENTIONER);

    expect(await mentionTitles(fix)).toEqual(Array(2).fill('ISS-1 — @solo mentioned you in "Fix"'));
    expect(await mentionTitles(named)).toEqual(
      Array(2).fill('ISS-2 — someone mentioned you in "Named"'),
    );
    expect(first).toEqual([
      '0344: 2 stored mention title(s) now name who mentioned the reader as core calls them; 2 whose handle names no one person were left as they are',
    ]);
    expect(second).toEqual([
      '0344: 0 stored mention title(s) now name who mentioned the reader as core calls them; 4 whose handle names no one person were left as they are',
    ]);
  });

  it('runs again over titles it already rewrote and changes nothing', async () => {
    await person(null, 'mai@example.com');
    const issueId = await issueTitled(1, 'Fix the import');
    await storedMention(issueId, '@mai mentioned you in "Fix the import"');
    await runRestore(MENTIONER);
    const after = await mentionTitles(issueId);
    expect(after).toEqual(Array(2).fill('ISS-1 — Another member mentioned you in "Fix the import"'));
    const notices = await runRestore(MENTIONER);
    expect(await mentionTitles(issueId)).toEqual(after);
    expect(notices).toEqual([
      '0344: 0 stored mention title(s) now name who mentioned the reader as core calls them; 0 whose handle names no one person were left as they are',
    ]);
  });
});
