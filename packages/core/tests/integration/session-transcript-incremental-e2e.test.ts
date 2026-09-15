/**
 * ISS-1020 — the incremental derive folds only the events past its checkpoint,
 * against a real Postgres.
 *
 * The unit lane cannot fail on any of this. `agent-stream-parser.test.ts` can
 * prove the fold resumes, but every claim that matters here is about the
 * database: which rows the second flush actually read, that the stored jsonb is
 * the same transcript a full rebuild stores, that a foreign write is refused
 * rather than folded onto, and that a write losing the compare-and-swap puts
 * nothing over the row that beat it. A mocked client would answer each of those
 * with whatever the mock was told to say.
 *
 * The cursor is proved POSITIVELY: after a flush, the events it already folded
 * are rewritten in place to carry text no transcript should ever show again. A
 * second flush that still reads them renders the poison; one that reads only
 * past its checkpoint cannot.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ws/broadcast.js', () => ({
  broadcast: vi.fn(),
  broadcastToProject: vi.fn(),
}));

let turnSyncFailsOnce = false;
vi.mock('../../src/agent-sessions/turns-helpers.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/agent-sessions/turns-helpers.js')>();
  return {
    ...real,
    syncTurnsWithMessages: async (...args: Parameters<typeof real.syncTurnsWithMessages>) => {
      if (turnSyncFailsOnce) {
        turnSyncFailsOnce = false;
        throw new Error('planted turn-sync failure');
      }
      return real.syncTurnsWithMessages(...args);
    },
  };
});

import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let transcript: typeof import('../../src/jobs/session-transcript.js');
let parser: typeof import('../../src/lib/agent-stream-parser.js');
let logger: typeof import('../../src/logger.js').logger;

let jobId: string;
let sessionId: string;
let projectId: string;
let deviceId: string;
let ownerId: string;
let runId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  transcript = await import('../../src/jobs/session-transcript.js');
  parser = await import('../../src/lib/agent-stream-parser.js');
  logger = (await import('../../src/logger.js')).logger;
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  turnSyncFailsOnce = false;
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, owner.id);
  const device = await createTestDevice(harness.db, owner.id);
  ownerId = owner.id;
  projectId = project.id;
  deviceId = device.id;

  runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
    VALUES (${runId}, ${projectId}, 'pm', 'running', now())
  `);

  ({ jobId, sessionId } = await seedSession());
});

/** A job and the agent_session linked to it, in the project seeded above. */
async function seedSession(): Promise<{ jobId: string; sessionId: string }> {
  const sid = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, status, pipeline_run_id)
    VALUES (${sid}, ${projectId}, ${deviceId}, 'running', ${runId})
  `);
  const jid = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO jobs (
      id, project_id, type, status, device_id, agent_session_id,
      pipeline_run_id, payload, queued_at, dispatched_at, created_by
    )
    VALUES (
      ${jid}, ${projectId}, 'review', 'dispatched', ${deviceId}, ${sid},
      ${runId}, '{}'::jsonb, now(), now(), ${ownerId}
    )
  `);
  return { jobId: jid, sessionId: sid };
}

/** The stream every case builds on, as `{ ts, line }` in seq order. Tool call
 *  `t1` is opened at index 2 and settled at index 4, so any split between them
 *  puts the settle in a later flush than its call. */
const LINES: { ts: number; line: unknown }[] = [
  { ts: 1_000, line: { type: 'system', subtype: 'init', session_id: 'claude-incremental' } },
  {
    ts: 1_100,
    line: {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'the original line' }], model: 'opus' },
    },
  },
  {
    ts: 1_200,
    line: {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a.ts' } }] },
    },
  },
  {
    ts: 1_500,
    line: { type: 'assistant', message: { content: [{ type: 'text', text: 'while it runs' }] } },
  },
  {
    ts: 2_400,
    line: {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body', is_error: true }],
      },
    },
  },
  {
    ts: 2_600,
    line: { type: 'assistant', message: { content: [{ type: 'text', text: 'and afterwards' }] } },
  },
  { ts: 3_900, line: { type: 'result', total_cost_usd: 0.42, num_turns: 3 } },
];

/** Insert `LINES[from..to)` as stdout job_events, seq `from+1..to`. */
async function insertEvents(from: number, to: number, job: string = jobId): Promise<void> {
  for (let i = from; i < to; i++) {
    const l = LINES[i];
    if (!l) throw new Error(`no line at ${i}`);
    await harness.db.execute(sql`
      INSERT INTO job_events (job_id, kind, data, seq, ts)
      VALUES (${job}, 'stdout', ${JSON.stringify({ line: l.line })}::jsonb, ${i + 1},
              to_timestamp(${l.ts / 1000}))
    `);
  }
}

/** Rewrite every already-inserted event up to `seq` so its text can never be
 *  mistaken for the original — a flush that re-reads them renders this. */
async function poisonEventsUpTo(seq: number): Promise<void> {
  await harness.db.execute(sql`
    UPDATE job_events
    SET data = jsonb_set(data, '{line,message,content}',
                         '[{"type":"text","text":"POISONED"}]'::jsonb)
    WHERE job_id = ${jobId} AND seq <= ${seq}
      AND data #>> '{line,type}' = 'assistant'
  `);
}

/** Flush, and refuse to assert on a gate that never opened. */
async function flush(): Promise<void> {
  const p = transcript.maybeDeriveIncremental(jobId, sessionId, 8);
  expect(p, 'the throttle gate did not open').not.toBeNull();
  await p;
}

async function storedMessages(session: string = sessionId): Promise<Record<string, unknown>[]> {
  const rows = await harness.db.execute<{ messages: Record<string, unknown>[] }>(
    sql`SELECT messages FROM agent_sessions WHERE id = ${session}`,
  );
  return rows[0]?.messages ?? [];
}

/** The turn table as (index, role, the id of the message the row carries). */
async function storedTurns(session: string = sessionId): Promise<unknown[]> {
  const rows = await harness.db.execute<{
    turn_index: number;
    role: string;
    content: { value: { id: string } };
  }>(sql`SELECT turn_index, role, content FROM agent_session_turns
         WHERE agent_session_id = ${session} ORDER BY turn_index ASC`);
  return rows.map((r) => [r.turn_index, r.role, r.content.value.id]);
}

/** What a full re-derive of every event stores, after the jsonb round trip the
 *  column puts every transcript through. */
async function fullRebuild(): Promise<unknown> {
  const rows = await harness.db.execute<{ kind: string; data: unknown; ts: Date }>(
    sql`SELECT kind, data, ts FROM job_events WHERE job_id = ${jobId} ORDER BY seq ASC`,
  );
  return JSON.parse(JSON.stringify(parser.buildSessionFromEvents(rows).messages));
}

function textOf(messages: Record<string, unknown>[]): string {
  return JSON.stringify(messages);
}

describe('incremental transcript derivation', () => {
  it('reads only the events past its checkpoint', async () => {
    await insertEvents(0, 4);
    await flush();
    expect(textOf(await storedMessages())).toContain('the original line');

    // cm:why the assertion below is what proves the CURSOR rather than the output: everything the first flush folded now reads POISONED on disk, so only a flush that re-reads those rows can put it in the transcript.
    await poisonEventsUpTo(4);
    await insertEvents(4, 7);
    await flush();

    const after = await storedMessages();
    expect(textOf(after)).not.toContain('POISONED');
    expect(textOf(after)).toContain('the original line');
    expect(textOf(after)).toContain('and afterwards');
  });

  it('stores what a full re-derive of every event stores', async () => {
    await insertEvents(0, 3);
    await flush();
    await insertEvents(3, 7);
    await flush();
    expect(await storedMessages()).toEqual(await fullRebuild());
  });

  it('settles a tool result whose call was folded by an earlier flush', async () => {
    await insertEvents(0, 4);
    await flush();
    await insertEvents(4, 7);
    await flush();

    const calls = (await storedMessages()).flatMap(
      (m) =>
        (m.toolCalls as {
          id: string;
          output?: string;
          isError?: boolean;
          durationMs?: number;
        }[]) ?? [],
    );
    const t1 = calls.find((c) => c.id === 't1');
    expect(t1?.output).toBe('file body');
    expect(t1?.isError).toBe(true);
    expect(t1?.durationMs).toBe(1_200);
  });

  it('leaves the turn table where a full re-derive of the same events leaves it', async () => {
    await insertEvents(0, 3);
    await flush();
    await insertEvents(3, 7);
    await flush();

    // cm:guard the control is the SAME two batches, each derived by a full rebuild — what every flush did before this change — and NOT the events derived in one pass. One pass leaves a turn table the two-batch path has never produced (docs/proposals/a-turn-row-goes-stale-when-the-transcript-grows-past-it.md), so comparing against it asserts a fix nobody made here.
    const other = await seedSession();
    await insertEvents(0, 3, other.jobId);
    await transcript.deriveSessionFinal(other.jobId, other.sessionId);
    await insertEvents(3, 7, other.jobId);
    await transcript.deriveSessionFinal(other.jobId, other.sessionId);

    expect(await storedMessages()).toEqual(await storedMessages(other.sessionId));
    expect(await storedTurns()).toEqual(await storedTurns(other.sessionId));
    expect((await storedTurns()).length).toBeGreaterThan(1);
  });

  it('re-derives from every event when the stored transcript is not the one it wrote', async () => {
    await insertEvents(0, 4);
    await flush();
    const warn = vi.spyOn(logger, 'warn');

    // cm:why a content-only rewrite: not one message id, type or timestamp moves, so nothing but the bytes themselves can tell this transcript from the one the checkpoint wrote.
    await harness.db.execute(sql`
      UPDATE agent_sessions
      SET messages = jsonb_set(messages, '{1,content}', '"a stranger wrote this"'::jsonb)
      WHERE id = ${sessionId}
    `);
    await insertEvents(4, 7);
    await flush();

    const after = await storedMessages();
    expect(textOf(after)).not.toContain('a stranger wrote this');
    expect(after).toEqual(await fullRebuild());
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: sessionId }),
      expect.stringContaining('not the one this checkpoint wrote'),
    );
  });

  it('re-derives from every event when it holds no checkpoint', async () => {
    await insertEvents(0, 4);
    const debug = vi.spyOn(logger, 'debug');
    await flush();
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: sessionId }),
      expect.stringContaining('no checkpoint'),
    );

    // cm:why nothing is carried across, so poisoning what this flush read has to show through the next derive — which is the only way to see from outside that it read the lot.
    await poisonEventsUpTo(4);
    await transcript.deriveSessionFinal(jobId, sessionId);
    expect(textOf(await storedMessages())).toContain('POISONED');
  });

  it('re-derives from every event on the final derive, whatever checkpoint stands', async () => {
    await insertEvents(0, 4);
    await flush();
    await poisonEventsUpTo(4);
    await insertEvents(4, 7);
    await transcript.deriveSessionFinal(jobId, sessionId);
    expect(textOf(await storedMessages())).toContain('POISONED');
  });

  it('leaves no checkpoint behind when the write throws', async () => {
    await insertEvents(0, 4);
    await flush();

    turnSyncFailsOnce = true;
    await insertEvents(4, 6);
    await flush();

    // cm:why the failed flush must leave no checkpoint claiming its write landed, and the only way to see that from outside is to poison what the FIRST flush folded and watch it come through.
    await poisonEventsUpTo(4);
    await insertEvents(6, 7);
    await flush();
    expect(textOf(await storedMessages())).toContain('POISONED');
  });

  it('drops a session state that has gone longer than the eviction window without a flush', async () => {
    await insertEvents(0, 4);
    await flush();

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60_000);

    await poisonEventsUpTo(4);
    await insertEvents(4, 7);
    await flush();
    expect(textOf(await storedMessages())).toContain('POISONED');
  });

  it('stores nothing over a transcript that changed after it read it', async () => {
    await insertEvents(0, 4);
    await flush();
    const warn = vi.spyOn(logger, 'warn');

    // cm:why the race is made deterministic by a second connection holding the row under an uncommitted write: the flush reads the version it can still see (its own, matching its checkpoint), then BLOCKS on the update, and the commit below replaces the transcript underneath it. Postgres re-checks the compare-and-swap against what landed, which is the whole mechanism under test — a timing-based version of this asserts nothing about the interleaving that matters.
    const held = await harness.client.reserve();
    let flushed: Promise<void> | null = null;
    try {
      await held.unsafe('BEGIN');
      // cm:guard a same-SHAPE rewrite, one message's content and nothing else. A shorter array would move the bytes too, but it also breaks the lockstep `syncTurnsWithMessages` assumes between the turn table and `prev`, and the derive would then fail on the turn index unique constraint rather than on the swap this case is about.
      await held.unsafe(
        `UPDATE agent_sessions SET messages = jsonb_set(messages, '{0,content}', '"held"'::jsonb) WHERE id = $1`,
        [sessionId],
      );
      await insertEvents(4, 7);
      flushed = transcript.maybeDeriveIncremental(jobId, sessionId, 8);
      expect(flushed).not.toBeNull();
      await waitForBlockedUpdate();
      await held.unsafe('COMMIT');
    } finally {
      held.release();
    }
    await flushed;

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: sessionId }),
      expect.stringContaining('moved under this derive'),
    );
    expect(await storedMessages()).toEqual(await fullRebuild());
  });
});

/** Wait until the derive's UPDATE is the backend waiting on the row lock. */
async function waitForBlockedUpdate(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const rows = await harness.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query ILIKE '%update%agent_sessions%'
    `);
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the derive never blocked on the row lock');
}
