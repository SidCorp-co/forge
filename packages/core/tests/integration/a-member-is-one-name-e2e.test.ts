/**
 * ISS-1229 r49 — judge-146: a person with no display name was "Another member" to every notice, list and
 * hint, and "A member" to the room that signs their messages. The coordinator's ruling: every surface
 * says "a member". New text follows lib/person-name.ts; what was stored in the old word is re-rendered by
 * migration 0396, in the person slot of each stored template and nowhere else.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { registerInboxFixture } from '../helpers/inbox-fixture.js';

const MIGRATION = fileURLToPath(
  new URL('../../drizzle/migrations/0396_a_member_is_one_name.sql', import.meta.url),
);

const fx = registerInboxFixture();

/** The migration with "another member" and "a member" traded, in either case: its way back. */
function swapped(text: string): string {
  const words: Record<string, string> = {
    'Another member': 'A member',
    'another member': 'a member',
    'A member': 'Another member',
    'a member': 'another member',
  };
  // A letter, not a word boundary, bounds the words: '\1A member\2' puts a back-reference's digit before them.
  return text.replace(
    /(?<![A-Za-z])(?:Another member|another member|A member|a member)(?![A-Za-z])/g,
    (w) => words[w] ?? w,
  );
}

async function runMigration(): Promise<string[]> {
  const notices: string[] = [];
  const postgres = (await import('postgres')).default;
  const client = postgres(process.env.DATABASE_URL ?? '', {
    max: 1,
    onnotice: (n) => notices.push(n.message ?? ''),
  });
  try {
    await client.unsafe(readFileSync(MIGRATION, 'utf8'));
  } finally {
    await client.end({ timeout: 5 });
  }
  return notices.filter((n) => n.startsWith('0396'));
}

/** An issue numbered as the delivery door names it, so a notice about it is led by "ISS-<seq> — ". */
async function anIssue(seq: number): Promise<string> {
  const id = crypto.randomUUID();
  await fx.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, created_by_id, iss_seq)
    VALUES (${id}, ${fx.project.id}, 'Fix the login', 'open', ${fx.owner}, ${seq})
  `);
  return id;
}

/** A notice told to the owner with a title as core wrote it before this round, and its bell row. */
async function told(title: string, issueId?: string): Promise<string> {
  const row = await fx.mods.recordAndDeliver({
    type: 'mention',
    recipients: [fx.owner],
    projectId: fx.project.id,
    ...(issueId ? { issueId } : {}),
    title,
  });
  if (!row) throw new Error(`nothing recorded for ${title}`);
  return row.id;
}

async function titlesOf(id: string): Promise<{ notice: string; bell: string[] }> {
  const [notice] = (await fx.db.execute(
    sql`SELECT title FROM notifications WHERE id = ${id}`,
  )) as unknown as Array<{ title: string }>;
  const bell = (await fx.db.execute(sql`
    SELECT d.title FROM notification_deliveries d
      JOIN notification_delivery_members m ON m.delivery_id = d.id
     WHERE m.notification_id = ${id}
  `)) as unknown as Array<{ title: string }>;
  return { notice: notice?.title ?? '', bell: bell.map((b) => b.title) };
}

async function roomLine(content: string): Promise<string> {
  const [room] = (await fx.db.execute(sql`
    INSERT INTO conversations (adapter, external_id) VALUES ('web', ${crypto.randomUUID()}) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [line] = (await fx.db.execute(sql`
    INSERT INTO conversation_messages (conversation_id, seq, role, author_label, content)
    VALUES (${room?.id}, 0, 'system', 'system', ${content}) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return line?.id as string;
}

async function contentOf(id: string): Promise<string> {
  const [row] = (await fx.db.execute(
    sql`SELECT content FROM conversation_messages WHERE id = ${id}`,
  )) as unknown as Array<{ content: string }>;
  return row?.content ?? '';
}

async function comment(body: string): Promise<string> {
  const issueId = crypto.randomUUID();
  await fx.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, created_by_id)
    VALUES (${issueId}, ${fx.project.id}, 'Ship it', 'awaiting_release', ${fx.owner})
  `);
  const [row] = (await fx.db.execute(sql`
    INSERT INTO comments (issue_id, author_id, body) VALUES (${issueId}, ${fx.owner}, ${body}) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return row?.id as string;
}

async function bodyOf(id: string): Promise<string> {
  const [row] = (await fx.db.execute(
    sql`SELECT body FROM comments WHERE id = ${id}`,
  )) as unknown as Array<{ body: string }>;
  return row?.body ?? '';
}

const SHIPPED = (who: string) =>
  `Release v1.2.0 ships this issue's landing abc1234 while it stands at Awaiting release and off the release's roster. ${who} decided, when pressing the release, to ship it unverified: the judge is away`;

describe('migration 0396: a person with no name reads "a member" in what core stored', () => {
  it('re-renders the person slot of a stored mention, invitation and waiting park, on the notice and its bell row', async () => {
    const ids = [
      await told('Another member mentioned you in "Fix the login"', await anIssue(41)),
      await told('Another member invited you to Invoicing as member'),
      await told("INV-3 is waiting for another member's decision — Invoicing"),
      await told('INV-4 is waiting for something only another member can supply — Invoicing'),
    ];
    const before = await Promise.all(ids.map(titlesOf));
    for (const t of before) expect(t.notice).toMatch(/another member/i);
    // The delivery door led the mention's bell row with its issue, as it does every mention core sends.
    expect(before[0]?.bell).toEqual(['ISS-41 — Another member mentioned you in "Fix the login"']);

    const said = await runMigration();

    const after = await Promise.all(ids.map(titlesOf));
    const reRendered = (title: string) =>
      title.replace('Another member', 'A member').replace('another member', 'a member');
    expect(after.map((t) => t.notice)).toEqual(before.map((t) => reRendered(t.notice)));
    expect(after.map((t) => t.notice)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/A member mentioned you in "Fix the login"$/),
        expect.stringMatching(/A member invited you to Invoicing as member$/),
        expect.stringMatching(
          /INV-3 is waiting for a member's decision — Invoicing$|is waiting for a member's decision — Invoicing$/,
        ),
        expect.stringMatching(/is waiting for something only a member can supply — Invoicing$/),
      ]),
    );
    for (const t of after) {
      expect(t.bell.length).toBeGreaterThan(0);
      for (const title of t.bell) expect(title).not.toMatch(/another member/i);
    }
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(
      /^0396: "another member" re-rendered as "a member" in 4 notice title\(s\), 4 bell row title\(s\)/,
    );
  });

  it('leaves an issue title that quotes the words as written, wherever it quotes them', async () => {
    const quoted = await told(
      'Lan mentioned you in "Another member mentioned you in the old bell"',
    );
    const afterADash = await told(
      'Mai mentioned you in "Plan — Another member mentioned you in "X""',
      await anIssue(42),
    );
    const invitedAfterADash = await told(
      'Mai invited you to Plan — Another member invited you to Invoicing as member',
    );
    const asks = await told('INV-5 — Ask another member about the release');
    const ids = [quoted, afterADash, invitedAfterADash, asks];
    const before = await Promise.all(ids.map(titlesOf));

    await runMigration();

    expect(await Promise.all(ids.map(titlesOf))).toEqual(before);
  });

  it("re-renders a room's join and leave lines, and no other line", async () => {
    const joined = await roomLine('Another member joined; this room is now a group.');
    const left = await roomLine('Another member left; this room is now a one-to-one chat.');
    const other = await roomLine('Another member said hello; this room is fine.');

    await runMigration();

    expect(await contentOf(joined)).toBe('A member joined; this room is now a group.');
    expect(await contentOf(left)).toBe('A member left; this room is now a one-to-one chat.');
    expect(await contentOf(other)).toBe('Another member said hello; this room is fine.');
  });

  it('re-renders who decided in a ship-unverified release comment, and nothing a person wrote', async () => {
    const shipped = await comment(SHIPPED('Another member'));
    const person = await comment(
      'Another member decided, when pressing the release, to ship it unverified.',
    );
    const quoting = await comment(`The release said: ${SHIPPED('Another member')}`);

    await runMigration();

    expect(await bodyOf(shipped)).toBe(SHIPPED('A member'));
    expect(await bodyOf(person)).toBe(
      'Another member decided, when pressing the release, to ship it unverified.',
    );
    expect(await bodyOf(quoting)).toBe(`The release said: ${SHIPPED('Another member')}`);
  });

  it('is undone by its statements with the two words swapped, which also re-render what core wrote since', async () => {
    const issue = await anIssue(43);
    const old = await told('Another member mentioned you in "Fix the login"', issue);
    const named = await told('Lan mentioned you in "Fix the login"', issue);
    const before = await Promise.all([old, named].map(titlesOf));
    await runMigration();
    // Written by this round's code after the deploy: the new word, in the same slot.
    const since = await told('A member invited you to Invoicing as member');

    await fx.db.execute(sql.raw(swapped(readFileSync(MIGRATION, 'utf8'))));

    expect(await Promise.all([old, named].map(titlesOf))).toEqual(before);
    expect((await titlesOf(since)).notice).toBe(
      'Another member invited you to Invoicing as member',
    );
  });
});
