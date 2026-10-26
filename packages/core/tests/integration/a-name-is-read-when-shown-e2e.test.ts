/**
 * ISS-1229 r25 — judge-72 at beta b28fd11: a room message stored its speaker's name as it stood when
 * they spoke, so a member who set a name after speaking still read "Another member" on their old line,
 * and 321 of beta's 374 person messages stored an email address that core served as the speaker's
 * name. The master's ruling: a message's author is named when the room is read, from the author's
 * current name; no label is stored; stored labels are dropped by a migration that aborts naming the row
 * it cannot convert; the API never serves an address as a label.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

const MIGRATION = fileURLToPath(
  new URL('../../drizzle/migrations/0354_a_name_is_read_when_shown.sql', import.meta.url),
);
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;

beforeAll(async () => {
  harness = await setupTestDatabase({ own: 'drops the conversation_messages label constraint' });
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let ownerId: string;
let speakerId: string;
let speakerEmail: string;
let projectId: string;
let roomId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  const speaker = await createTestUser(harness.db);
  speakerId = speaker.id;
  speakerEmail = speaker.email;
  await harness.db.execute(
    sql`UPDATE users SET email_verified_at = now() WHERE id IN (${ownerId}, ${speakerId})`,
  );
  const orgId = (await seedOrg(harness.db, ownerId)).id;
  await harness.db.execute(
    sql`INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${speakerId}, 'member')`,
  );
  projectId = (
    await createTestProject(harness.db, ownerId, { slug: 'names', name: 'Names', orgId })
  ).id;
  await harness.db.execute(
    sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${projectId}, ${speakerId}, 'member')`,
  );
  const opened = await as(ownerId, '/api/conversations', 'POST', {
    projectId,
    people: [speakerId],
  });
  expect(opened.status, await opened.clone().text()).toBe(201);
  roomId = ((await opened.json()) as { id: string }).id;
});

async function as(userId: string, path: string, method = 'GET', body?: unknown): Promise<Response> {
  const { signUserToken } = await import('../../src/auth/jwt.js');
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${await signUserToken(userId)}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function said(
  seq: number,
  label: string | null,
  userId: string | null = speakerId,
): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(
    sql`INSERT INTO conversation_messages (conversation_id, seq, role, author_user_id, author_label, content)
        VALUES (${roomId}, ${seq}, 'user', ${userId}, ${label}, ${`line ${seq}`}) RETURNING id`,
  );
  return rows[0]?.id as string;
}

async function servedLabels(): Promise<Array<string | null>> {
  const res = await as(ownerId, `/api/conversations/${roomId}`);
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as {
    messages: Array<{ role: string; authorLabel: string | null }>;
  };
  return body.messages.filter((m) => m.role === 'user').map((m) => m.authorLabel);
}

const named = (displayName: string | null) =>
  harness.db.execute(sql`UPDATE users SET display_name = ${displayName} WHERE id = ${speakerId}`);

describe("a speaker's name, read when the room is read", () => {
  it('is the name the speaker holds now, on a message they sent before they set it', async () => {
    await said(1, null);
    expect(await servedLabels()).toEqual(['Another member']);
    await named('Mai Tran');
    expect(await servedLabels()).toEqual(['Mai Tran']);
    await named(null);
    expect(await servedLabels()).toEqual(['Another member']);
  });

  it('is never a label stored with the message', async () => {
    await harness.db.execute(
      sql`ALTER TABLE conversation_messages DROP CONSTRAINT conversation_messages_label_holds_no_address`,
    );
    try {
      await said(1, speakerEmail);
      await said(2, 'Old Name');
      await named('Mai Tran');
      const labels = await servedLabels();
      expect(labels).toEqual(['Mai Tran', 'Mai Tran']);
      for (const label of labels) expect(label ?? '').not.toMatch(ADDRESS);
    } finally {
      await harness.db.execute(
        sql`DELETE FROM conversation_messages WHERE conversation_id = ${roomId}`,
      );
      await harness.db.execute(sql.raw(lastStatement()));
    }
  });

  it('is stored by no message a person sends in a web room', async () => {
    const sent = await as(speakerId, `/api/conversations/${roomId}/messages`, 'POST', {
      content: 'hello',
    });
    expect(sent.status, await sent.clone().text()).toBeLessThan(300);
    const rows = await harness.db.execute<{
      author_user_id: string | null;
      author_label: string | null;
    }>(
      sql`SELECT author_user_id, author_label FROM conversation_messages
           WHERE conversation_id = ${roomId} AND role = 'user'`,
    );
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { author_user_id: speakerId, author_label: null },
    ]);
  });

  // The diff review of round 25: a passage indexed before a rename kept the old name in its text.
  it('is the name search reads too, from the moment the speaker renames themself', async () => {
    const { indexConversationOnce, conversationsNeedingIndex } = await import(
      '../../src/conversations/transcript-index.js'
    );
    await named('Mai');
    await said(1, null);
    await indexConversationOnce(roomId);
    const passages = async () =>
      (
        await harness.db.execute<{ text: string }>(
          sql`SELECT text FROM conversation_passages WHERE conversation_id = ${roomId}`,
        )
      ).map((r) => r.text);
    expect((await passages()).join()).toContain('Mai');

    const res = await as(speakerId, '/api/auth/me', 'PATCH', { displayName: 'Lan Pham' });
    expect(res.status, await res.clone().text()).toBe(200);
    // No indexer pass between: the rename rebuilt the room's passages in its own transaction.
    expect((await passages()).join()).toContain('Lan Pham');
    expect((await passages()).join()).not.toMatch(/\bMai\b/);
    expect(await conversationsNeedingIndex(10)).not.toContain(roomId);
  });

  // ISS-1236 round 4: the room read named every person by their name, so a reader who set none read
  // their own line as "Another member", which the web's own thread never says of the viewer.
  it("is \"You\" to the reader who sent it, and the speaker's name to everyone else", async () => {
    await said(1, null);
    await said(2, null, ownerId);
    const read = async (reader: string) => {
      const res = await as(reader, `/api/conversations/${roomId}`);
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as {
        messages: Array<{ role: string; authorLabel: string | null }>;
      };
      return body.messages.filter((m) => m.role === 'user').map((m) => m.authorLabel);
    };
    expect(await read(speakerId)).toEqual(['You', 'Another member']);
    expect(await read(ownerId)).toEqual(['Another member', 'You']);
    await named('Mai Tran');
    expect(await read(speakerId)).toEqual(['You', 'Another member']);
    expect(await read(ownerId)).toEqual(['Mai Tran', 'You']);
  });

  it('is "You" to the sender in the message door\'s own answer', async () => {
    const sent = await as(speakerId, `/api/conversations/${roomId}/messages`, 'POST', {
      content: 'hello',
    });
    expect(sent.status, await sent.clone().text()).toBeLessThan(300);
    const body = (await sent.json()) as {
      messages: Array<{ role: string; authorUserId: string | null; authorLabel: string | null }>;
    };
    const mine = body.messages.filter((m) => m.role === 'user' && m.authorUserId === speakerId);
    expect(mine.map((m) => m.authorLabel)).toEqual(['You']);
  });

  it('can never be an address the database stores', async () => {
    const refused = await said(1, speakerEmail, null).then(
      () => null,
      (err: { cause?: { constraint_name?: string } }) => err.cause?.constraint_name,
    );
    expect(refused).toBe('conversation_messages_label_holds_no_address');
  });
});

/** The CHECK the migration ends on, the statement after its last breakpoint. */
function lastStatement(): string {
  const parts = readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint');
  return parts[parts.length - 1] ?? '';
}

/** The migration whole, or only its data block: the CHECK it ends on is added once, as drizzle runs it. */
async function runMigration(dataOnly = false): Promise<string[]> {
  const notices: string[] = [];
  const postgres = (await import('postgres')).default;
  const client = postgres(process.env.DATABASE_URL ?? '', {
    max: 1,
    onnotice: (n) => notices.push(n.message ?? ''),
  });
  try {
    const statements = readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint');
    for (const statement of dataOnly ? statements.slice(0, 1) : statements) {
      if (statement.trim()) await client.unsafe(statement);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
  return notices.filter((n) => n.startsWith('0354'));
}

describe('migration 0354', () => {
  beforeEach(async () => {
    await harness.db.execute(
      sql`ALTER TABLE conversation_messages DROP CONSTRAINT IF EXISTS conversation_messages_label_holds_no_address`,
    );
  });

  afterAll(async () => {
    await harness.db.execute(sql`DELETE FROM conversation_messages`);
    await harness.db.execute(
      sql`ALTER TABLE conversation_messages DROP CONSTRAINT IF EXISTS conversation_messages_label_holds_no_address`,
    );
    await harness.db.execute(sql.raw(lastStatement()));
  });

  it('drops every stored label of a person in a web room, links an address to its one account, and counts both', async () => {
    const snapshot = await said(1, 'Old Name');
    const address = await said(2, speakerEmail);
    const unlinked = await said(3, speakerEmail.toUpperCase(), null);
    const system = await harness.db.execute<{ id: string }>(
      sql`INSERT INTO conversation_messages (conversation_id, seq, role, author_label, content)
          VALUES (${roomId}, 4, 'system', 'system', 'someone joined') RETURNING id`,
    );

    expect(await runMigration()).toEqual([
      '0354: 2 stored speaker label(s) dropped, each name now read from its person; 1 message(s) named by an address linked to the account holding it',
    ]);
    const rows = await harness.db.execute<{
      id: string;
      author_user_id: string | null;
      author_label: string | null;
    }>(
      sql`SELECT id, author_user_id, author_label FROM conversation_messages WHERE conversation_id = ${roomId}`,
    );
    const by = new Map(rows.map((r) => [r.id, { user: r.author_user_id, label: r.author_label }]));
    expect(by.get(snapshot)).toEqual({ user: speakerId, label: null });
    expect(by.get(address)).toEqual({ user: speakerId, label: null });
    expect(by.get(unlinked)).toEqual({ user: speakerId, label: null });
    expect(by.get(system[0]?.id as string)).toEqual({ user: null, label: 'system' });

    expect(await runMigration(true)).toEqual([
      '0354: 0 stored speaker label(s) dropped, each name now read from its person; 0 message(s) named by an address linked to the account holding it',
    ]);
  });

  it('aborts naming the message whose address no single account holds, and changes nothing', async () => {
    const kept = await said(1, 'Old Name');
    const stray = await said(2, 'nobody@nowhere.example', null);

    await expect(runMigration()).rejects.toThrow(
      new RegExp(
        `0354: message ${stray} \\(seq 2 in conversation ${roomId}\\) names its speaker by an email address that no single account holds`,
      ),
    );
    const rows = await harness.db.execute<{ id: string; author_label: string | null }>(
      sql`SELECT id, author_label FROM conversation_messages WHERE id IN (${kept}, ${stray})`,
    );
    expect(new Map(rows.map((r) => [r.id, r.author_label]))).toEqual(
      new Map([
        [kept, 'Old Name'],
        [stray, 'nobody@nowhere.example'],
      ]),
    );
  });
});
