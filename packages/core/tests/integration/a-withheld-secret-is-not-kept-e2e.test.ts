/**
 * ISS-1229 r43 — judge-120 at beta 08eb48d: a reply the reply check withdrew because it held a
 * token-looking URL was stored whole on the reply that replaced it, as `withdrawnDraft`, and served to
 * every reader of the room. The master's ruling: a withheld draft keeps no text the check flagged as a
 * credential; the row says that a reply was withdrawn and why, never what it said. Migration 0378 clears
 * the rows already holding one, and aborts naming a draft it cannot read.
 *
 * The migration's own file is run over seeded rows, and its answer for each draft is held to the reply
 * check's own predicate, so the SQL cannot drift from the scrubber it restates.
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
  new URL('../../drizzle/migrations/0378_a_withheld_secret_is_not_kept.sql', import.meta.url),
);
const SECRET = 'Zq8VtR2mK9xLp4Wd';

/** Drafts on both sides of every scrubber pattern, and the near misses beside each. */
const DRAFTS = [
  `Sign in at https://app.example.com/cb?token=${SECRET} to finish.`,
  `Open https://app.example.com/cb?page=2&API_KEY=${SECRET}#top`,
  'Open https://app.example.com/cb?tokens=2 for the list.',
  'Open https://app.example.com/cb?token=&page=2 for the list.',
  `The deploy password: ${SECRET} is in the vault.`,
  `{"accessToken": "${SECRET}"}`,
  'The password reset link is on the login page.',
  'Set password: "" to clear it.',
  'my_token: abc is a variable name.',
  'The tokenizer: splits words.',
  `Authorization: Bearer ${SECRET}`,
  'Authorization is required for this call.',
  'authorization:\r\nnext line',
  `curl -H "X-Api-Key=${SECRET}" https://example.com`,
  `Use forge_pat_prd_${'ab12'.repeat(8)} for the call.`,
  'The prefix forge_pat_dev_ starts every token.',
  `ya29.${SECRET} is the access token.`,
  'ya29 is a prefix.',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
  '-----BEGIN PUBLIC KEY-----\nMIIBIj\n-----END PUBLIC KEY-----',
  `export DB_PASSWORD=${SECRET}`,
  `Two lines\n  STRIPE_SECRET_KEY = ${SECRET}\nend`,
  'DB_PASSWORD=hunter2\r\nnext',
  `The password:\u00a0${SECRET} line.`,
  `export\u00a0GH_TOKEN=${SECRET}`,
  'GH_TOKEN=\u2028',
  'DB_PASSWORD=',
  'db_password=lowercase is not an env line',
  'ISS-4242 shipped in v9.2.',
  "**ISS-999** is not on this project's tracker.",
];

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let readsAsCredential: (text: string) => boolean;

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
  ({ readsAsCredential } = await import('../../src/messaging/text-rules.js'));
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
  projectId = (
    await createTestProject(harness.db, ownerId, { slug: 'vault', name: 'Vault', orgId })
  ).id;
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

/** An assistant reply whose delivery proof carries `proof`, as the turn runner stored them before r43. */
async function replied(seq: number, proof: Record<string, unknown>): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(
    sql`INSERT INTO conversation_messages (conversation_id, seq, role, content, delivery_proof)
        VALUES (${roomId}, ${seq}, 'assistant', ${`reply ${seq}`}, ${JSON.stringify({ messageId: null, ...proof })}::jsonb)
        RETURNING id`,
  );
  return rows[0]?.id as string;
}

async function migrate(): Promise<void> {
  for (const statement of readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim()) await harness.db.execute(sql.raw(statement));
  }
}

async function proofOf(id: string): Promise<Record<string, unknown>> {
  const rows = await harness.db.execute<{ proof: Record<string, unknown> }>(
    sql`SELECT delivery_proof AS proof FROM conversation_messages WHERE id = ${id}`,
  );
  return rows[0]?.proof as Record<string, unknown>;
}

describe('migration 0378 — a withdrawn draft that held a credential is cleared', () => {
  it('clears exactly the drafts the reply check reads as a credential, and keeps every other', async () => {
    const ids = [];
    for (const [i, draft] of DRAFTS.entries())
      ids.push(await replied(i, { withdrawnDraft: draft }));
    const untouched = await replied(DRAFTS.length, {});

    await migrate();

    const flagged = DRAFTS.filter((d) => readsAsCredential(d));
    expect(flagged.length).toBeGreaterThan(8);
    expect(DRAFTS.length - flagged.length).toBeGreaterThan(8);
    for (const [i, draft] of DRAFTS.entries()) {
      const proof = await proofOf(ids[i] as string);
      const said = JSON.stringify(draft);
      if (readsAsCredential(draft)) {
        expect(proof, `${said} reads as a credential and was kept`).toEqual({
          messageId: null,
          withdrawnFor: 'credential',
        });
      } else {
        expect(proof, `${said} reads as no credential and was cleared`).toEqual({
          messageId: null,
          withdrawnDraft: draft,
        });
      }
    }
    expect(await proofOf(untouched)).toEqual({ messageId: null });
  });

  it('serves a cleared reply as withdrawn for a credential, with none of its text', async () => {
    await replied(0, { withdrawnDraft: DRAFTS[0] });
    await replied(1, { withdrawnDraft: 'ISS-4242 shipped in v9.2.' });

    await migrate();

    const res = await as(ownerId, `/api/conversations/${roomId}`);
    expect(res.status, await res.clone().text()).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const { messages } = JSON.parse(text) as {
      messages: Array<{ role: string; withdrawnDraft: string | null; withdrawnFor: string | null }>;
    };
    const replies = messages.filter((m) => m.role === 'assistant');
    expect(replies.map((m) => [m.withdrawnDraft, m.withdrawnFor])).toEqual([
      [null, 'credential'],
      ['ISS-4242 shipped in v9.2.', null],
    ]);
  });

  it('aborts the deploy naming a withdrawn draft that is not text, and changes nothing', async () => {
    const flagged = await replied(0, { withdrawnDraft: DRAFTS[0] });
    const odd = await replied(1, { withdrawnDraft: { text: 'not a string' } });

    const refusal = await migrate().then(
      () => null,
      (err: unknown) => String((err as { cause?: unknown }).cause ?? err),
    );

    expect(refusal).toContain(`0378: message ${odd} (seq 1 in conversation ${roomId})`);
    expect(refusal).toContain('is not text');
    expect(await proofOf(flagged)).toEqual({ messageId: null, withdrawnDraft: DRAFTS[0] });
  });
});

describe('a reply recorded after r43', () => {
  it('stores why a draft was withdrawn for a credential, and no text, and serves it so', async () => {
    const { recordDeliveredReply } = await import('../../src/conversations/transcript.js');
    await recordDeliveredReply({
      conversationId: roomId,
      projectId,
      text: 'I cannot share that here.',
      receipt: { messageId: null },
      withdrawnFor: 'credential',
    });

    const rows = await harness.db.execute<{ proof: Record<string, unknown> }>(
      sql`SELECT delivery_proof AS proof FROM conversation_messages WHERE conversation_id = ${roomId} AND role = 'assistant'`,
    );
    expect(rows[0]?.proof).toEqual({ messageId: null, withdrawnFor: 'credential' });
    const res = await as(ownerId, `/api/conversations/${roomId}`);
    const { messages } = (await res.json()) as {
      messages: Array<{ role: string; withdrawnDraft: string | null; withdrawnFor: string | null }>;
    };
    const replies = messages.filter((m) => m.role === 'assistant');
    expect(replies.map((m) => [m.withdrawnDraft, m.withdrawnFor])).toEqual([[null, 'credential']]);
  });
});
