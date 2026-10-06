/**
 * ISS-1027 — an over-age row leaves every swept table, and each rule's
 * exemption keeps the row it exists for.
 *
 * Both halves are load-bearing and only the pair is evidence. A suite that
 * planted one old row per table and watched it go would pass identically
 * against `DELETE FROM <table>` with no predicate at all, which is the shape
 * that takes a runner's carry-in event and a live job's transition audit with
 * it. So every table gets a fresh row too, and the predicated tables get an
 * over-age row their rule protects.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { runRetentionSweep } from '../../src/pipeline/retention/sweep.js';
import { rows } from '../helpers/factories.js';
import { retentionWorld } from '../helpers/retention-world.js';

const fx = retentionWorld();
beforeEach(() => fx.reset());

async function idsIn(table: string): Promise<string[]> {
  const found = await rows<{ id: string }>(
    sql`SELECT id::text AS id FROM ${sql.raw(`"${table}"`)} ORDER BY id`,
  );
  return found.map((r) => r.id).sort();
}

async function sweptBy(table: string) {
  const result = await runRetentionSweep();
  const found = result.tables.find((t) => t.table === table);
  if (!found) throw new Error(`no retention rule reported for ${table}`);
  return found;
}

describe('retention sweep: the window (ISS-1027)', () => {
  it('removes an over-age row from every swept table and keeps a fresh one', async () => {
    const runner = await fx.insertRunner();
    // Two events BEFORE the window, because the newer of those is the carry-in
    // the rule keeps — which is what makes the older one removable at all.
    await fx.insertRunnerEvent(runner, 200);
    await fx.insertRunnerEvent(runner, 100);
    await fx.insertQueueSnapshot(200);
    await fx.insertQueueSnapshot(1);
    const doneJob = await fx.insertJob({ status: 'done' });
    await fx.insertKernelTransition('job', doneJob, 200);
    await fx.insertKernelTransition('job', doneJob, 1);

    const result = await runRetentionSweep();
    const deleted = Object.fromEntries(result.tables.map((t) => [t.table, t.deleted]));

    expect(await fx.count('runner_events')).toBe(1);
    expect(await fx.count('queue_snapshots')).toBe(1);
    expect(await fx.count('kernel_transitions')).toBe(1);
    expect(deleted).toMatchObject({
      runner_events: 1,
      queue_snapshots: 1,
      kernel_transitions: 1,
    });
  });

  it('reports the window it swept each table at', async () => {
    const result = await runRetentionSweep();
    const windows = Object.fromEntries(result.tables.map((t) => [t.table, t.windowDays]));

    expect(windows).toMatchObject({
      job_events: 30,
      queue_snapshots: 90,
      runner_events: 90,
      kernel_transitions: 90,
      agent_session_events: 30,
    });
  });

  it('holds nothing back on a table whose rule has no exemption', async () => {
    await fx.insertQueueSnapshot(200);

    expect((await sweptBy('queue_snapshots')).heldBack).toBe(0);
  });

  it('never sweeps mcp_audit_log or agent_session_turns, whatever the age of the rows', async () => {
    const result = await runRetentionSweep();
    const rules = Object.fromEntries(result.tables.map((t) => [t.table, t]));

    expect(rules.mcp_audit_log?.windowDays).toBeNull();
    expect(rules.mcp_audit_log?.deleted).toBe(0);
    expect(rules.agent_session_turns?.windowDays).toBeNull();
    expect(rules.agent_session_turns?.deleted).toBe(0);
  });
});

describe('retention sweep: the exemptions (ISS-1027)', () => {
  it("keeps a runner's newest event however old it is, and counts it held", async () => {
    const runner = await fx.insertRunner();
    const carryIn = await fx.insertRunnerEvent(runner, 400);

    const swept = await sweptBy('runner_events');

    expect(await idsIn('runner_events')).toEqual([carryIn]);
    expect(swept.deleted).toBe(0);
    expect(swept.heldBack).toBe(1);
  });

  it('keeps the newest event BEFORE the window, not merely the newest overall', async () => {
    const runner = await fx.insertRunner();
    await fx.insertRunnerEvent(runner, 200);
    const carryIn = await fx.insertRunnerEvent(runner, 100);
    const inWindow = await fx.insertRunnerEvent(runner, 10);

    const swept = await sweptBy('runner_events');

    expect(await idsIn('runner_events')).toEqual([carryIn, inWindow].sort());
    expect(swept.deleted).toBe(1);
    expect(swept.heldBack).toBe(1);
  });

  it('keeps the newest event of EVERY runner, not just of one', async () => {
    const a = await fx.insertRunner();
    const b = await fx.insertRunner();
    const keptA = await fx.insertRunnerEvent(a, 300);
    const keptB = await fx.insertRunnerEvent(b, 400);
    await fx.insertRunnerEvent(a, 500);

    await runRetentionSweep();

    expect(await idsIn('runner_events')).toEqual([keptA, keptB].sort());
  });

  it('keeps a transition whose job is still running and removes one whose job is done', async () => {
    const live = await fx.insertJob({ status: 'running', type: 'code' });
    const dead = await fx.insertJob({ status: 'done', type: 'review' });
    const held = await fx.insertKernelTransition('job', live, 200);
    await fx.insertKernelTransition('job', dead, 200);

    const swept = await sweptBy('kernel_transitions');

    expect(await idsIn('kernel_transitions')).toEqual([held]);
    expect(swept.deleted).toBe(1);
    expect(swept.heldBack).toBe(1);
  });

  it('keeps a transition whose entity this sweep cannot resolve', async () => {
    const unknown = await fx.insertKernelTransition('widget', await fx.insertJob({}), 200);

    const swept = await sweptBy('kernel_transitions');

    expect(await idsIn('kernel_transitions')).toEqual([unknown]);
    expect(swept.deleted).toBe(0);
  });

  it('counts only the exempt rows when the batch cap leaves eligible ones behind', async () => {
    const live = await fx.insertJob({ status: 'running', type: 'code' });
    const dead = await fx.insertJob({ status: 'done', type: 'review' });
    const session = await fx.insertSession({ status: 'running' });
    const held = await fx.insertKernelTransition('session', session, 200);
    await fx.insertKernelTransition('job', dead, 200);
    await fx.insertKernelTransition('job', dead, 201);
    const liveHeld = await fx.insertKernelTransition('job', live, 200);

    const result = await runRetentionSweep({ batchSize: 1, maxBatches: 1 });
    const swept = result.tables.find((t) => t.table === 'kernel_transitions');

    expect(swept?.deleted).toBe(1);
    expect(swept?.capped).toBe(true);
    expect(swept?.heldBack).toBe(2);
    // One eligible transition survived the cap, and it is not in the held count.
    const left = await idsIn('kernel_transitions');
    expect(left).toHaveLength(3);
    expect(left).toEqual(expect.arrayContaining([held, liveHeld]));
  });

  it('keeps a transition whose session is still running', async () => {
    const session = await fx.insertSession({ status: 'running' });
    const held = await fx.insertKernelTransition('session', session, 200);

    await runRetentionSweep();

    expect(await idsIn('kernel_transitions')).toEqual([held]);
  });

  it('keeps the transitions of an issue still in flight, and lets a dropped issue’s go', async () => {
    const open = await fx.insertKernelTransition('issue', fx.ids.issueId, 200);
    const closedIssue = await insertIssueAt('dropped');
    await fx.insertKernelTransition('issue', closedIssue, 200);

    const swept = await sweptBy('kernel_transitions');

    expect(await idsIn('kernel_transitions')).toEqual([open]);
    expect(swept).toMatchObject({ deleted: 1, heldBack: 1 });
  });

  it('keeps the transitions of a run still running', async () => {
    const held = await fx.insertKernelTransition('run', fx.ids.runId, 200);

    const swept = await sweptBy('kernel_transitions');

    expect(await idsIn('kernel_transitions')).toEqual([held]);
    expect(swept).toMatchObject({ deleted: 0, heldBack: 1 });
  });
});

async function insertIssueAt(status: string): Promise<string> {
  const [row] = await rows<{ id: string }>(sql`
    INSERT INTO issues (project_id, created_by_id, title, status)
    VALUES (${fx.ids.projectId}, ${fx.ids.ownerId}, 'terminal fixture', ${status})
    RETURNING id
  `);
  return String(row?.id);
}
