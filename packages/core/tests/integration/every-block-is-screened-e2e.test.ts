/**
 * ISS-1229 r44 — judge-124 at beta dc2c4b5: a token-looking URL in an issue description, read by the
 * room's tool, went out in every live frame and stayed in the stored reply's tool output, because the
 * screen read only prose. The master's ruling: every block a frame or a stored message carries passes the
 * one credential screen. Migration 0380 clears what is already stored, and aborts naming a row whose
 * blocks it cannot read one by one.
 *
 * The migration's own file is run over seeded rows, every string of every block kind held to the screen's
 * own predicate, so the SQL cannot drift from the code it restates.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JSON_SHAPED, PROSE, SECRET, UNDECODABLE_IN_SQL } from '../helpers/credential-corpus.js';
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
  new URL('../../drizzle/migrations/0380_every_block_is_screened.sql', import.meta.url),
);
const CORPUS = [...PROSE, ...JSON_SHAPED];
const FILTERED = '[Filtered]';

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let readsAsCredential: (text: string) => boolean;
let screened: <T>(value: T) => T;

beforeAll(async () => {
  harness = await setupTestDatabase();
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
  ({ readsAsCredential, screened } = await import('../../src/messaging/credential-screen.js'));
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let ownerId: string;
let projectId: string;
let roomId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  const member = await createTestUser(harness.db);
  await harness.db.execute(
    sql`UPDATE users SET email_verified_at = now() WHERE id IN (${ownerId}, ${member.id})`,
  );
  const orgId = (await seedOrg(harness.db, ownerId)).id;
  await harness.db.execute(
    sql`INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${member.id}, 'member')`,
  );
  projectId = (await createTestProject(harness.db, ownerId, { slug: 'desk', name: 'Desk', orgId }))
    .id;
  await harness.db.execute(
    sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${projectId}, ${member.id}, 'member')`,
  );
  const opened = await as(ownerId, '/api/conversations', 'POST', {
    projectId,
    people: [member.id],
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

/** Every kind of block, each carrying `text`, as a reply stored before r44 kept them. */
const everyKind = (text: string) => [
  { type: 'text', text },
  { type: 'thinking', thinking: text },
  { type: 'tool', toolCall: { id: 't1', name: 'forge', input: { body: text }, output: text } },
  { type: 'todos', todos: [{ content: text, status: 'pending' }] },
];

/** An assistant row stored straight into the table, as rows before this change were. */
async function stored(seq: number, blocks: unknown, proof: unknown = null): Promise<string> {
  const json = (value: unknown) => (value === null ? null : JSON.stringify(value));
  const rows = await harness.db.execute<{ id: string }>(
    sql`INSERT INTO conversation_messages (conversation_id, seq, role, content, blocks, delivery_proof)
        VALUES (${roomId}, ${seq}, 'assistant', ${`reply ${seq}`}, ${json(blocks)}::jsonb,
                ${json(proof)}::jsonb)
        RETURNING id`,
  );
  return rows[0]?.id as string;
}

/** The file as drizzle applies it: each statement in turn, in one transaction on one connection. */
async function migrate(): Promise<void> {
  const statements = readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint');
  await harness.db.transaction(async (tx) => {
    for (const statement of statements) if (statement.trim()) await tx.execute(sql.raw(statement));
  });
}

async function blocksOf(id: string): Promise<unknown> {
  const rows = await harness.db.execute<{ blocks: unknown }>(
    sql`SELECT blocks FROM conversation_messages WHERE id = ${id}`,
  );
  return rows[0]?.blocks;
}

/** Every string a value holds, at any depth. */
const stringsOf = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : value && typeof value === 'object'
      ? Object.values(value).flatMap(stringsOf)
      : [];

describe('migration 0380 — every stored block passes the one screen', () => {
  it('clears exactly the strings the screen reads as a credential, in every kind of block', async () => {
    const ids = [];
    for (const [i, text] of CORPUS.entries()) ids.push(await stored(i, everyKind(text)));

    await migrate();

    const flagged = CORPUS.filter((t) => readsAsCredential(t));
    expect(flagged.length).toBeGreaterThan(12);
    expect(CORPUS.length - flagged.length).toBeGreaterThan(12);
    for (const [i, text] of CORPUS.entries()) {
      const said = JSON.stringify(text);
      const after = await blocksOf(ids[i] as string);
      expect(after, `${said} reads as a credential and was kept`).toEqual(
        everyKind(readsAsCredential(text) ? FILTERED : text),
      );
    }
  });

  it('clears whole, unread, JSON that Postgres cannot decode, holding none it could find', async () => {
    const ids = [];
    for (const [i, text] of UNDECODABLE_IN_SQL.entries())
      ids.push(await stored(i, everyKind(text)));
    const plain = await stored(UNDECODABLE_IN_SQL.length, everyKind('{"note": "plain"}'));

    await migrate();

    for (const id of ids) expect(await blocksOf(id)).toEqual(everyKind(FILTERED));
    expect(await blocksOf(plain)).toEqual(everyKind('{"note": "plain"}'));
  });

  it('clears a tool input value its own key names a secret, as the screen does', async () => {
    const inputs = [
      { password: SECRET },
      { auth: { api_key: SECRET, region: 'eu' } },
      { token: 4821, note: 'kept' },
      { password: '', max_tokens: 1000, tokens: 'many' },
    ];
    const ids = [];
    for (const [i, input] of inputs.entries())
      ids.push(await stored(i, [{ type: 'tool', toolCall: { id: 't1', name: 'forge', input } }]));

    await migrate();

    for (const [i, input] of inputs.entries()) {
      const expected = [
        { type: 'tool', toolCall: { id: 't1', name: 'forge', input: screened(input) } },
      ];
      expect(await blocksOf(ids[i] as string), JSON.stringify(input)).toEqual(expected);
    }
    expect(JSON.stringify(await blocksOf(ids[0] as string))).not.toContain(SECRET);
    expect(JSON.stringify(await blocksOf(ids[1] as string))).not.toContain(SECRET);
  });

  it('screens a password whose key and value a tool call split into two text blocks', async () => {
    const id = await stored(0, [
      { type: 'text', text: 'The deploy password: ' },
      { type: 'tool', toolCall: { id: 't1', name: 'forge', input: {}, output: 'ok' } },
      { type: 'text', text: `${SECRET} is the one.` },
    ]);

    await migrate();

    const after = await blocksOf(id);
    expect(JSON.stringify(after)).not.toContain(SECRET);
    expect(after).toEqual([
      { type: 'tool', toolCall: { id: 't1', name: 'forge', input: {}, output: 'ok' } },
      { type: 'text', text: FILTERED },
    ]);
  });

  it('clears the withdrawn drafts the widened predicate reads as a credential', async () => {
    const quotedKey = await stored(0, null, {
      messageId: null,
      withdrawnDraft: `{"password": "${SECRET}"}`,
    });
    const harmless = await stored(1, null, {
      messageId: null,
      withdrawnDraft: 'ISS-4242 shipped in v9.2.',
    });

    await migrate();

    const proofs = await harness.db.execute<{ id: string; proof: unknown }>(
      sql`SELECT id, delivery_proof AS proof FROM conversation_messages ORDER BY seq`,
    );
    expect(proofs.map((r) => [r.id, r.proof])).toEqual([
      [quotedKey, { messageId: null, withdrawnFor: 'credential' }],
      [harmless, { messageId: null, withdrawnDraft: 'ISS-4242 shipped in v9.2.' }],
    ]);
  });

  it('serves a screened room with none of the secret to any reader', async () => {
    await stored(0, everyKind(JSON_SHAPED[5] as string));
    await migrate();

    const res = await as(ownerId, `/api/conversations/${roomId}`);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.text()).not.toContain(SECRET);
  });

  it('aborts the deploy naming stored blocks that are not a list, and changes nothing', async () => {
    const flagged = await stored(0, everyKind(PROSE[0] as string));
    const odd = await stored(1, { text: 'not a list' });

    const refusal = await migrate().then(
      () => null,
      (err: unknown) => String((err as { cause?: unknown }).cause ?? err),
    );

    expect(refusal).toContain(`0380: message ${odd} (seq 1 in conversation ${roomId})`);
    expect(refusal).toContain('not a list');
    expect(await blocksOf(flagged)).toEqual(everyKind(PROSE[0] as string));
  });
});

describe('a reply stored after r44', () => {
  it('keeps no credential in any block, whoever writes the row', async () => {
    const { recordDeliveredReply } = await import('../../src/conversations/transcript.js');
    await recordDeliveredReply({
      conversationId: roomId,
      projectId,
      text: 'It needs a build link.',
      receipt: { messageId: null },
      blocks: everyKind(JSON_SHAPED[5] as string) as never,
    });

    const rows = await harness.db.execute<{ blocks: unknown }>(
      sql`SELECT blocks FROM conversation_messages WHERE conversation_id = ${roomId} AND role = 'assistant'`,
    );
    const strings = stringsOf(rows[0]?.blocks);
    expect(strings.length).toBeGreaterThan(4);
    for (const s of strings) expect(readsAsCredential(s), s).toBe(false);
    const res = await as(ownerId, `/api/conversations/${roomId}`);
    expect(await res.text()).not.toContain(SECRET);
  });
});
