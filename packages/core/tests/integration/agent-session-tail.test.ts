import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('agent_sessions reads that must not carry a transcript', () => {
  let harness: TestDatabase;
  let projectId: string;
  let runId: string;
  let readAgentSession: typeof import('../../src/agent-sessions/service.js').readAgentSession;
  let listAgentSessionsForMcp: typeof import('../../src/agent-sessions/service.js').listAgentSessionsForMcp;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    // The service module pulls `config/env.ts` through `db/client.js`, which validates the whole
    // environment at import time — so these must be set BEFORE the dynamic import below, not in a
    // config file the import would race.
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-pepper-at-least-32-chars-long-abcdef-12';
    const service = await import('../../src/agent-sessions/service.js');
    readAgentSession = service.readAgentSession;
    listAgentSessionsForMcp = service.listAgentSessionsForMcp;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    projectId = project.id;
    runId = randomUUID();
    await harness.db.execute(
      sql`INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${runId}, ${projectId}, 'interactive', 'running')`,
    );
  });

  async function seedSession(args: {
    messageCount: number;
    turns: number | null;
    nullMessages?: boolean;
  }): Promise<string> {
    const id = randomUUID();
    const messages = args.nullMessages
      ? null
      : JSON.stringify(
          Array.from({ length: args.messageCount }, (_, i) => ({ role: 'user', content: `m${i}` })),
        );
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, kind, status, messages, metadata)
      VALUES (
        ${id}, ${projectId}, ${runId}, 'chat', 'completed',
        ${messages === null ? sql`'[]'::jsonb` : sql`${messages}::jsonb`},
        ${JSON.stringify({ issueId: 'not-a-real-issue' })}::jsonb
      )
    `);
    if (args.turns !== null) {
      for (let i = 0; i < args.turns; i++) {
        await harness.db.execute(sql`
          INSERT INTO agent_session_turns (agent_session_id, turn_index, role, content)
          VALUES (${id}, ${i}, 'user', ${JSON.stringify({ text: `t${i}` })}::jsonb)
        `);
      }
    }
    return id;
  }

  it('returns the LAST twenty messages, in transcript order, from a longer transcript', async () => {
    const id = await seedSession({ messageCount: 35, turns: 35 });

    const row = await readAgentSession(id);

    const messages = row?.messages as Array<{ content: string }>;
    expect(messages).toHaveLength(20);
    // The first and last of the tail are what separate "last 20" from "first 20" and from a
    // reversed slice — a length assertion alone passes all three.
    expect(messages[0]?.content).toBe('m15');
    expect(messages[19]?.content).toBe('m34');
  });

  it('reports the true total of the transcript, not the length of the tail', async () => {
    const id = await seedSession({ messageCount: 35, turns: 35 });

    const row = await readAgentSession(id);

    expect((row as { totalMessages: number }).totalMessages).toBe(35);
  });

  it('returns a short transcript whole rather than failing on a negative offset', async () => {
    const id = await seedSession({ messageCount: 3, turns: 3 });

    const row = await readAgentSession(id);

    const messages = row?.messages as Array<{ content: string }>;
    expect(messages).toHaveLength(3);
    expect(messages[0]?.content).toBe('m0');
    expect((row as { totalMessages: number }).totalMessages).toBe(3);
  });

  it('returns [] and 0 for an empty transcript', async () => {
    const id = await seedSession({ messageCount: 0, turns: 0, nullMessages: true });

    const row = await readAgentSession(id);

    expect(row?.messages).toEqual([]);
    expect((row as { totalMessages: number }).totalMessages).toBe(0);
  });

  it('never selects the messages column into a list page', async () => {
    await seedSession({ messageCount: 35, turns: 35 });

    const rows = await listAgentSessionsForMcp({ projectId, limit: 10 });

    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {})).not.toContain('messages');
  });

  it('counts a list row off the turn ledger', async () => {
    await seedSession({ messageCount: 35, turns: 7 });

    const rows = await listAgentSessionsForMcp({ projectId, limit: 10 });

    // 7 turns, not the 35 messages — the ledger is the source, and a value of 35 here would mean
    // the transcript was read after all.
    expect(rows[0]?.messageCount).toBe(7);
  });

  it('reports null, NOT zero, for a session the turn ledger does not cover', async () => {
    await seedSession({ messageCount: 35, turns: 0 });

    const rows = await listAgentSessionsForMcp({ projectId, limit: 10 });

    expect(rows[0]?.messageCount).toBeNull();
    expect(rows[0]?.messageCount).not.toBe(0);
  });
});
