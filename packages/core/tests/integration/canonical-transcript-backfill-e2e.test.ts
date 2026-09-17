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

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  ({ backfillCanonicalTranscripts: backfill, revertCanonicalTranscripts: revert } = await import(
    '../../src/db/backfill-canonical-transcripts.js'
  ));
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

/** The raw `postgres` handle the backfill takes — the same one migrate.ts hands it. */
async function rawSql() {
  const postgres = (await import('postgres')).default;
  return postgres(harness.url, { max: 1 });
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
    // cm:guard read back through the reader that lost its `role` branch, because
    // that is the claim: criterion 10 is "a session stored in the old shape still
    // renders", and the shape the renderer needs is the only thing that proves it.
    const { messageRoleToTurnRole } = await import('../../src/agent-sessions/turns-helpers.js');
    expect(messages.map((m) => messageRoleToTurnRole(m))).toEqual(['user', 'assistant']);
    expect(messages[1]?.blocks).toEqual([
      { type: 'text', text: 'Editing now' },
      { type: 'tool', toolCall: { id: 'tc1', name: 'Edit', input: { file_path: 'a.ts' } } },
    ]);
  });

  // cm:guard the TURN table is converted too, and leaving it out is the half that
  // would have shipped silently: the web formatter reads a turn row's own entry,
  // so an unconverted one renders every stored user turn as an agent row the
  // moment `entryRole` loses its branch.
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
    // cm:guard the refusal NAMES the row so an operator can act on it, and the
    // bad entry is still there afterwards. A migration that deleted it to make
    // the ALTER succeed would have lost somebody's conversation to a deploy.
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

  // cm:guard the inverse is what makes the rollback a rewrite rather than a
  // guess. The forward pass edits rows IN PLACE, so restoring the legacy readers
  // does not restore the rows they read — and serving `role`-shaped readers
  // against canonical rows is the class of failure ISS-807 was.
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
