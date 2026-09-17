/**
 * ISS-1027 — a terminal job's events do not go until the transcript they would
 * rebuild is recorded as finalised, and what ends that hold is the repair pass
 * rather than an age.
 *
 * The first case in this file is the planted race, and it is planted against
 * the code as it stood at `d0389485c` rather than described: that sweep joined
 * nothing that could say whether the transcript had been written, so a job
 * whose finalisation never completed lost the only rows it could be rebuilt
 * from. It runs that exact statement and watches the events go, so the rest of
 * this file is evidence of a fix rather than of a hypothesis.
 *
 * It also rules out the proxy this issue nearly shipped. `maybeDeriveIncremental`
 * and `deriveSessionFinal` write the SAME `agent_sessions.messages` column, so a
 * non-empty transcript proves a derive ran and nothing about which one. Every
 * held case here carries a non-empty transcript for that reason: read the column
 * instead of the marker and they all go green while deleting a partial
 * transcript's source.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRetentionFixture, type RetentionFixture } from '../helpers/retention-fixture.js';

let fx: RetentionFixture;

/** A transcript an incremental flush would leave: written, and not final. */
const PARTIAL = [{ id: 'm1', role: 'assistant', content: 'half a turn' }];
const OLD = 40;

beforeAll(async () => {
  fx = await createRetentionFixture();
}, 60_000);
afterAll(async () => {
  if (fx) await fx.harness.cleanup();
});
beforeEach(() => fx.reset());

/** A terminal job with one over-age event, on a session with the given metadata. */
async function plantAgedJob(opts: { metadata?: unknown; type?: string } = {}) {
  const sessionId = await fx.insertSession({ metadata: opts.metadata ?? {}, messages: PARTIAL });
  const jobId = await fx.insertJob({
    status: 'done',
    sessionId,
    finishedDaysAgo: OLD,
    ...(opts.type ? { type: opts.type } : {}),
  });
  await fx.insertJobEvent(jobId, OLD, 1);
  return { sessionId, jobId };
}

async function jobEvents(): Promise<number> {
  return fx.count('job_events');
}

describe('the transcript rule: what the old sweep did (ISS-1027)', () => {
  it('the pre-ISS-1027 statement deletes the events of a job whose transcript was never finalised', async () => {
    await plantAgedJob();
    expect(await jobEvents()).toBe(1);

    // The sweep as it stood at d0389485c, verbatim but for the batch size: a
    // window and a terminal status, and no join that could see the transcript.
    await fx.harness.db.execute(sql`
      DELETE FROM job_events
      WHERE id IN (
        SELECT id FROM job_events
        WHERE ts < now() - interval '30 days'
          AND job_id IN (SELECT id FROM jobs WHERE status IN ('done', 'failed', 'cancelled'))
        LIMIT 100
      )
    `);

    expect(await jobEvents()).toBe(0);
  });
});

describe('the transcript rule: what the sweep does now (ISS-1027)', () => {
  it('holds the events while the session records no finalisation, and counts them held', async () => {
    await plantAgedJob();

    const result = await fx.mods.runRetentionSweep();
    const swept = result.tables.find((t) => t.table === 'job_events');

    expect(await jobEvents()).toBe(1);
    expect(swept?.deleted).toBe(0);
    expect(swept?.heldBack).toBe(1);
  });

  it('removes them once the session records the finalisation', async () => {
    await plantAgedJob({ metadata: { transcriptFinalizedAt: new Date().toISOString() } });

    const result = await fx.mods.runRetentionSweep();

    expect(await jobEvents()).toBe(0);
    expect(result.tables.find((t) => t.table === 'job_events')?.deleted).toBe(1);
  });

  it('removes them for a job that has no agent session at all', async () => {
    const jobId = await fx.insertJob({ status: 'done', sessionId: null, finishedDaysAgo: OLD });
    await fx.insertJobEvent(jobId, OLD, 1);

    await fx.mods.runRetentionSweep();

    expect(await jobEvents()).toBe(0);
  });

  it('holds the events of a job that is still running, finalised or not', async () => {
    const sessionId = await fx.insertSession({
      metadata: { transcriptFinalizedAt: new Date().toISOString() },
    });
    const jobId = await fx.insertJob({ status: 'running', sessionId, type: 'code' });
    await fx.insertJobEvent(jobId, OLD, 1);

    await fx.mods.runRetentionSweep();

    expect(await jobEvents()).toBe(1);
  });
});

describe('the transcript rule: the repair pass (ISS-1027)', () => {
  it('finalises an unfinalised transcript, and a later run removes its events', async () => {
    const { sessionId } = await plantAgedJob();

    await fx.mods.runRetentionSweep();
    expect(await jobEvents()).toBe(1);
    expect(await fx.metadataOf(sessionId)).toHaveProperty('transcriptFinalizedAt');

    await fx.mods.runRetentionSweep();
    expect(await jobEvents()).toBe(0);
  });

  it('records the finalisation in the same write that stores the transcript', async () => {
    const sessionId = await fx.insertSession({ messages: [] });
    const jobId = await fx.insertJob({ status: 'done', sessionId, finishedDaysAgo: OLD });
    await fx.insertJobEvent(jobId, OLD, 1, {
      kind: 'progress',
      data: { claudeSessionId: 'claude-abc' },
    });

    await fx.mods.runRetentionSweep();

    const rows = (await fx.harness.db.execute(sql`
      SELECT claude_session_id, metadata ->> 'transcriptFinalizedAt' AS finalized
      FROM agent_sessions WHERE id = ${sessionId}
    `)) as unknown as Array<{ claude_session_id: string | null; finalized: string | null }>;
    expect(rows[0]?.claude_session_id).toBe('claude-abc');
    expect(rows[0]?.finalized).not.toBeNull();
  });

  it('stamps the attempt on every session it tries, so a failure rotates to the back', async () => {
    const { sessionId } = await plantAgedJob();

    await fx.mods.runRetentionSweep();

    expect(await fx.metadataOf(sessionId)).toHaveProperty('transcriptFinalizeAttemptedAt');
  });

  // cm:guard this is the anti-starvation property and the only thing that makes the per-run bound safe: order the candidates by the job's age instead and the two sessions attempted longest ago take the budget on every run for ever, and the one never tried is never tried. The bound is one here so a wrong ORDER BY cannot hide behind a budget wide enough to reach everybody anyway.
  it('spends the repair bound least-recently-attempted first', async () => {
    process.env.RETENTION_FINALIZE_REPAIR_MAX = '1';
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const recent = new Date(Date.now() - 3_600_000).toISOString();
    // The one with no attempt at all is also the NEWEST job, so an order by age
    // would reach it last rather than first.
    const stale = await plantAgedJob({
      metadata: { transcriptFinalizeAttemptedAt: yesterday },
      type: 'code',
    });
    const recentlyTried = await plantAgedJob({
      metadata: { transcriptFinalizeAttemptedAt: recent },
      type: 'review',
    });
    const never = await plantAgedJob({ type: 'test' });

    try {
      await fx.mods.runRetentionSweep();
      expect(await fx.metadataOf(never.sessionId)).toHaveProperty('transcriptFinalizedAt');
      expect(await fx.metadataOf(stale.sessionId)).not.toHaveProperty('transcriptFinalizedAt');
      expect(await fx.metadataOf(recentlyTried.sessionId)).not.toHaveProperty(
        'transcriptFinalizedAt',
      );

      await fx.mods.runRetentionSweep();
      expect(await fx.metadataOf(stale.sessionId)).toHaveProperty('transcriptFinalizedAt');
      expect(await fx.metadataOf(recentlyTried.sessionId)).not.toHaveProperty(
        'transcriptFinalizedAt',
      );
    } finally {
      delete process.env.RETENTION_FINALIZE_REPAIR_MAX;
    }
  });
});
