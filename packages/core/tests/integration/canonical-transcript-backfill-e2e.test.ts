/**
 * ISS-1030 — the backfill that lets the two legacy readers come out, and the
 * row it refuses to convert, against real Postgres.
 *
 * This is a data migration, so the assertions are about ROWS: what the tables
 * hold afterwards, and what the deploy does when it meets an entry the canonical
 * shape cannot represent. It aborts naming the row. Nothing is dropped to make
 * it succeed — that is the whole rule, and the reason it is a test rather than a
 * comment.
 */

import { randomUUID } from 'node:crypto';
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

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let backfill: typeof import('../../src/db/backfill-canonical-transcripts.js').backfillCanonicalTranscripts;
let revert: typeof import('../../src/db/backfill-canonical-transcripts.js').revertCanonicalTranscripts;
let once: typeof import('../../src/db/backfill-canonical-transcripts.js').runCanonicalBackfillOnce;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  ({
    backfillCanonicalTranscripts: backfill,
    revertCanonicalTranscripts: revert,
    runCanonicalBackfillOnce: once,
  } = await import('../../src/db/backfill-canonical-transcripts.js'));
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
});

async function rawSql() {
  const postgres = (await import('postgres')).default;
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const client = postgres(harness.url, { max: 1 });
  drizzle(client);
  return client;
}

async function migratedSql() {
  const sql = await rawSql();
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  await migrate(drizzle(sql), {
    migrationsFolder: fileURLToPath(new URL('../../drizzle/migrations', import.meta.url)),
  });
  return sql;
}

async function sessionWithMessages(messages: unknown[]): Promise<string> {
  const id = randomUUID();
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${projectId}, 'interactive', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, user_id, pipeline_run_id, status, messages)
    VALUES (${id}, ${projectId}, ${ownerId}, ${runId}, 'completed', ${JSON.stringify(messages)}::jsonb)
  `);
  return id;
}

async function turnOn(sessionId: string, entry: unknown): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_session_turns (id, agent_session_id, turn_index, role, content)
    VALUES (${id}, ${sessionId}, 0, 'user', ${JSON.stringify({ value: entry })}::jsonb)
  `);
  return id;
}

async function messagesOf(sessionId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await harness.db.execute<{ messages: unknown }>(
    sql`SELECT messages FROM agent_sessions WHERE id = ${sessionId}`,
  );
  return (rows[0] as { messages: Array<Record<string, unknown>> }).messages;
}

async function turnEntryOf(turnId: string): Promise<Record<string, unknown>> {
  const rows = await harness.db.execute<{ content: { value: Record<string, unknown> } }>(
    sql`SELECT content FROM agent_session_turns WHERE id = ${turnId}`,
  );
  return (rows[0] as { content: { value: Record<string, unknown> } }).content.value;
}

describe('the canonical-transcript backfill', () => {
  it('rewrites a legacy transcript into the one shape the readers left standing read', async () => {
    const id = await sessionWithMessages([
      { role: 'user', content: 'fix the bug' },
      {
        role: 'assistant',
        content: 'Editing now',
        contentBlocks: [
          { type: 'text', text: 'Editing now' },
          { type: 'tool_use', tool: { id: 'tc1', name: 'Edit', input: { file_path: 'a.ts' } } },
        ],
      },
    ]);
    const sql$ = await rawSql();
    try {
      const report = await backfill(sql$);
      expect(report.entries).toBe(2);
    } finally {
      await sql$.end();
    }

    const messages = await messagesOf(id);
    const { messageRoleToTurnRole } = await import('../../src/agent-sessions/turns-helpers.js');
    expect(messages.map((m) => messageRoleToTurnRole(m))).toEqual(['user', 'assistant']);
    expect(messages[1]?.blocks).toEqual([
      { type: 'text', text: 'Editing now' },
      { type: 'tool', toolCall: { id: 'tc1', name: 'Edit', input: { file_path: 'a.ts' } } },
    ]);
  });

  it('converts the turn rows as well as the blob', async () => {
    const id = await sessionWithMessages([{ type: 'user', content: 'hi' }]);
    const turnId = await turnOn(id, { role: 'user', content: 'hi' });
    const sql$ = await rawSql();
    try {
      await backfill(sql$);
    } finally {
      await sql$.end();
    }
    const entry = await turnEntryOf(turnId);
    expect(entry).toMatchObject({ type: 'user', content: 'hi' });
    expect(entry).not.toHaveProperty('role');
  });

  it('aborts naming the row it cannot represent, and converts nothing', async () => {
    const good = await sessionWithMessages([{ role: 'user', content: 'hi' }]);
    const bad = await sessionWithMessages([
      { role: 'user', content: 'hi' },
      { role: 'moderator', content: 'what even is this' },
    ]);
    const sql$ = await rawSql();
    try {
      await expect(backfill(sql$)).rejects.toThrow(/moderator/);
    } finally {
      await sql$.end();
    }
    const stillThere = await messagesOf(bad);
    expect(stillThere[1]).toMatchObject({ role: 'moderator' });
    expect(good).toBeTruthy();
  });

  it('is a no-op the second time, so a restart cannot double-convert', async () => {
    const id = await sessionWithMessages([{ role: 'user', content: 'hi' }]);
    const sql$ = await rawSql();
    try {
      expect((await backfill(sql$)).entries).toBe(1);
      expect((await backfill(sql$)).entries).toBe(0);
    } finally {
      await sql$.end();
    }
    expect(await messagesOf(id)).toHaveLength(1);
  });

  it('puts every converted entry back exactly as it stood', async () => {
    const before = [
      { role: 'user', content: 'fix the bug' },
      { role: 'assistant', contentBlocks: [{ type: 'text', text: 'ok' }] },
    ];
    const id = await sessionWithMessages(before);
    const turnId = await turnOn(id, { role: 'user', content: 'fix the bug' });
    const sql$ = await rawSql();
    try {
      await backfill(sql$);
      await revert(sql$);
    } finally {
      await sql$.end();
    }
    expect(await messagesOf(id)).toEqual(before);
    expect(await turnEntryOf(turnId)).toEqual({ role: 'user', content: 'fix the bug' });
  });
});

describe('the deploy refuses until the backfill has actually finished', () => {
  it('refuses again on the next boot, and marks only once the conversion returns', async () => {
    const good = await sessionWithMessages([{ role: 'user', content: 'hi' }]);
    const bad = await sessionWithMessages([{ role: 'moderator', content: 'nope' }]);
    const raw = await rawSql();
    try {
      await expect(once(raw)).rejects.toThrow(/moderator/);
      const afterFailure = await harness.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM backfill_markers`,
      );
      expect(Number((afterFailure[0] as { n: number }).n)).toBe(0);

      // The same boot again, as a restarting container is: still refused.
      await expect(once(raw)).rejects.toThrow(/moderator/);

      // The row is repaired, and the next attempt converts what is left.
      await harness.db.execute(
        sql`UPDATE agent_sessions SET messages = ${JSON.stringify([{ role: 'system', content: 'nope' }])}::jsonb WHERE id = ${bad}`,
      );
      const ran = await once(raw);
      expect(ran.ran).toBe(true);
      expect((await messagesOf(good))[0]).toMatchObject({ type: 'user' });
      expect((await messagesOf(bad))[0]).toMatchObject({ type: 'system' });

      // And a boot after that does not pay for the scan again.
      expect(await once(raw)).toEqual({ ran: false, reason: 'already-done' });

      await revert(raw);
      expect((await messagesOf(good))[0]).toMatchObject({ role: 'user' });
      const ranAgain = await once(raw);
      expect(ranAgain.ran).toBe(true);
      expect((await messagesOf(good))[0]).toMatchObject({ type: 'user' });
    } finally {
      await raw.end();
    }
  });
});

describe('the backfill runs on the client the deploy hands it', () => {
  it('converts a legacy row on a client drizzle has just migrated', async () => {
    const id = await sessionWithMessages([
      { role: 'user', content: 'where does the runner code live?' },
      {
        role: 'assistant',
        content: 'In packages/runner.',
        contentBlocks: [{ type: 'text', text: 'In packages/runner.' }],
      },
    ]);
    const turnId = await turnOn(id, { role: 'user', content: 'where does the runner code live?' });
    const sql = await migratedSql();
    try {
      const report = await backfill(sql);
      expect(report.entries).toBeGreaterThan(0);
    } finally {
      await sql.end();
    }
    expect((await messagesOf(id))[0]).toMatchObject({ type: 'user' });
    expect(await turnEntryOf(turnId)).toMatchObject({ type: 'user' });
  });
});
