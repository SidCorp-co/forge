/**
 * ISS-1229 r20 — judge-59 at beta 9974765: a mention named who mentioned you by the part of their
 * address before the "@". notify-mentions.ts now fills that slot through personName, and migration
 * 0344, read from its file, rewrites the mentions already stored.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestUser } from '../helpers/factories.js';
import { registerInboxFixture } from '../helpers/inbox-fixture.js';

const MENTIONER = fileURLToPath(
  new URL('../../drizzle/migrations/0344_a_mention_names_who_mentioned_you.sql', import.meta.url),
);

const fx = registerInboxFixture();

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

async function issueTitled(seq: number, title: string): Promise<string> {
  const id = crypto.randomUUID();
  await fx.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, created_by_id, iss_seq)
    VALUES (${id}, ${fx.project.id}, ${title}, 'in_progress', ${fx.owner}, ${seq})
  `);
  return id;
}

async function runMentioner(): Promise<string[]> {
  const notices: string[] = [];
  const postgres = (await import('postgres')).default;
  const client = postgres(process.env.DATABASE_URL ?? '', {
    max: 1,
    onnotice: (n) => notices.push(n.message ?? ''),
  });
  try {
    for (const statement of readFileSync(MENTIONER, 'utf8').split('--> statement-breakpoint')) {
      if (statement.trim()) await client.unsafe(statement);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
  return notices;
}

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
  ])(
    'a mentioner whose display name is %j reads %j, stored and in the bell',
    async (given, called) => {
      const mentioner = await person(given, 'lan.pham@example.com');
      const issueId = await issueTitled(7, 'Fix the export');
      await mentionBy(mentioner, issueId);

      const expected = `ISS-7 — ${called} mentioned you in "Fix the export"`;
      expect(await mentionTitles(issueId)).toEqual([expected, expected]);
      const [row] = (await fx.inbox()).items;
      expect(row?.title).toBe(expected);
      expect(row?.title).not.toContain('lan.pham');
    },
  );
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

    const notices = await runMentioner();

    const both = (t: string) => [t, t];
    expect(await mentionTitles(named)).toEqual(
      both('ISS-1 — Lan Pham mentioned you in "Fix the export"'),
    );
    expect(await mentionTitles(unnamed)).toEqual(
      both('ISS-2 — Another member mentioned you in "Fix the import"'),
    );
    expect(await mentionTitles(addressAsName)).toEqual(
      both('ISS-3 — Another member mentioned you in "Fix the "quoted" rows"'),
    );
    expect(await mentionTitles(twins)).toEqual(
      both('ISS-4 — Twin A mentioned you in "Ask the twins"'),
    );
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
    expect(await mentionTitles(done)).toEqual(
      both('ISS-9 — Lan Pham mentioned you in "Already named"'),
    );
    expect(await mentionTitles(caseOnly)).toEqual(
      both('ISS-10 — @SOLO mentioned you in "Case matters"'),
    );
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

    const first = await runMentioner();
    const second = await runMentioner();

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
    await runMentioner();
    const after = await mentionTitles(issueId);
    expect(after).toEqual(
      Array(2).fill('ISS-1 — Another member mentioned you in "Fix the import"'),
    );
    const notices = await runMentioner();
    expect(await mentionTitles(issueId)).toEqual(after);
    expect(notices).toEqual([
      '0344: 0 stored mention title(s) now name who mentioned the reader as core calls them; 0 whose handle names no one person were left as they are',
    ]);
  });
});
