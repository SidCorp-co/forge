/**
 * The builder rule kept beside each verdict (ISS-1070 r5, 0627): after every kind of write that moves
 * one of the rule's inputs, the model either holds what the rule answers now or the issue is marked,
 * and a read over it answers what the rule does. Each write here is chosen to flip a verdict's
 * answer, and the test checks the flip happened, so no step passes by moving nothing.
 *
 * Planted red: a write made with the input's trigger off (`session_replication_role = replica`, the
 * one way past it) leaves a verdict the rule now reads as its builder's held as not, and unmarked.
 *
 * @direct-test-of packages/core/src/issues/builder-facts.ts
 * @direct-test-of packages/core/src/issues/built-by.ts
 * @direct-test-of packages/core/src/issues/criteria/verdict-counting.ts
 * @direct-test-of packages/core/src/issues/criteria/live-verdicts.ts
 * @direct-test-of packages/core/src/boot-backfills.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  BUILDER_INPUT_TABLES,
  builderFactDrift,
  drainStaleBuilderFacts,
  keepBuilderFacts,
  liveBuilderFactsSql,
  sweepBuilderFacts,
} from '../../src/issues/builder-facts.js';
import { liveVerdictsOfIssues } from '../../src/issues/criteria/live-verdicts.js';
import {
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestRunSession,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';

const T0 = new Date('2026-11-01T08:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const SHA = 'd2dd9863e397c1b6b185bafdc06f9c7a88ee5589';

let ownerId: string;
let projectId: string;
let box: string;
let issueId: string;
let criterionId: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  box = await createTestDevice(ownerId);
  projectId = (await createTestProject(ownerId)).id;
  issueId = (await createTestIssue(projectId, ownerId, 5, { status: 'in_progress', createdAt: T0 }))
    .id;
  const [c] = await rows<{ id: string }>(sql`
    INSERT INTO issue_criteria (issue_id, n, statement, position)
    VALUES (${issueId}, 1, 'the page answers', 0) RETURNING id`);
  criterionId = c?.id as string;
});

/** A run session on the box from `start`, its run declared over `group` at `opened`; its session id. */
async function runSession(
  start: Date,
  group: string[],
  opened: Record<string, string>,
): Promise<{ runId: string; sessionId: string }> {
  const runId = await createTestRunSession(projectId, box, start, null);
  await db.execute(sql`
    UPDATE pipeline_runs SET metadata = ${JSON.stringify({
      type: 'run_session',
      runGroup: group,
      runIssueStatuses: opened,
    })}::jsonb WHERE id = ${runId}`);
  const [s] = await rows<{ id: string }>(
    sql`SELECT id FROM agent_sessions WHERE pipeline_run_id = ${runId}`,
  );
  return { runId, sessionId: s?.id as string };
}

/** A pass on c1 recorded at `when` by `session` (null: from the box with none named). */
async function pass(when: Date, session: string | null): Promise<string> {
  const [v] = await rows<{ id: string }>(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, identity_kind, commit_sha,
                                    author_agency, author_device_id, run_session_id, created_at)
    VALUES (${criterionId}, ${issueId}, 'pass', 'commit', ${SHA}, 'agent', ${box}, ${session},
            ${when.toISOString()}) RETURNING id`);
  return v?.id as string;
}

/** What the rule answers for each verdict now, computed live. */
async function live(): Promise<Map<string, boolean>> {
  const read = await rows<{ verdict_id: string; by_builder: boolean }>(
    liveBuilderFactsSql([issueId]),
  );
  return new Map(read.map((r) => [r.verdict_id, r.by_builder]));
}

async function marked(): Promise<boolean> {
  const [m] = await rows<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM issue_read_model_stale WHERE issue_id = ${issueId}`,
  );
  return (m?.n ?? 0) > 0;
}

/**
 * The model's two promises after a write: an unmarked issue's facts are what the rule answers (no
 * drift), and a read over the model answers what the rule does once it has made the facts current.
 */
async function modelHolds(): Promise<void> {
  expect(await builderFactDrift(db, [issueId])).toEqual([]);
  const read = await liveVerdictsOfIssues(db, [issueId]);
  const served = new Map(
    [...(read.get(issueId)?.values() ?? [])].flat().map((v) => [v.id, v.byBuilder]),
  );
  expect(served).toEqual(await live());
  expect(await marked()).toBe(false);
  expect(await builderFactDrift(db, [issueId])).toEqual([]);
}

/** Runs `write`, checks it flipped `verdict` to `to`, marked the issue, and the model holds. */
async function flips(verdict: string, to: boolean, write: () => Promise<void>): Promise<void> {
  await modelHolds();
  expect((await live()).get(verdict)).toBe(!to);
  await write();
  expect((await live()).get(verdict)).toBe(to);
  expect(await marked()).toBe(true);
  await modelHolds();
}

describe('the builder facts each write keeps', () => {
  it('writes the fact as the verdict is written, inside its transaction', async () => {
    const s = await runSession(at(0), ['ISS-5'], { 'ISS-5': 'in_progress' });
    await db.transaction(async (tx) => {
      const [v] = (await tx.execute(sql`
        INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, identity_kind, commit_sha,
                                        author_agency, author_device_id, run_session_id, created_at)
        VALUES (${criterionId}, ${issueId}, 'pass', 'commit', ${SHA}, 'agent', ${box}, ${s.sessionId},
                ${at(5).toISOString()}) RETURNING id`)) as unknown as { id: string }[];
      await keepBuilderFacts(tx, [issueId]);
      const [f] = (await tx.execute(
        sql`SELECT by_builder FROM verdict_builder_facts WHERE verdict_id = ${v?.id}`,
      )) as unknown as { by_builder: boolean }[];
      expect(f?.by_builder).toBe(true);
    });
    expect(await marked()).toBe(false);
    await modelHolds();
  });

  it('marks and rewrites on a check run, a lease, a run, a landing, a reopen, a session and its delete', async () => {
    // a judge declared after the work landed: not the builder until it records a check
    await db.execute(
      sql`UPDATE issues SET merged_at = ${at(1).toISOString()} WHERE id = ${issueId}`,
    );
    const judge = await runSession(at(2), ['ISS-5'], { 'ISS-5': 'in_progress' });
    const vJudge = await pass(at(3), judge.sessionId);
    await flips(vJudge, true, async () => {
      await db.execute(sql`
        INSERT INTO issue_check_runs (id, issue_id, kind, name, scope, command, result, duration_ms,
                                      started_at, head_sha, run_session_id, via, recorded_by)
        VALUES (${randomUUID()}, ${issueId}, 'tests', 'unit', 'core', 'pnpm test', 'pass', 10,
                ${at(3).toISOString()}, ${SHA}, ${judge.sessionId}, 'report', ${ownerId})`);
    });

    // a session of another issue's run: the builder once it holds this issue's lease, not after
    const other = await runSession(at(4), ['ISS-9'], { 'ISS-9': 'in_progress' });
    const vOther = await pass(at(5), other.sessionId);
    await flips(vOther, true, async () => {
      await db.execute(sql`
        INSERT INTO issue_leases (project_id, issue_key, device_id, session_id, run_id)
        VALUES (${projectId}, 'ISS-5', ${box}, ${other.sessionId}, ${other.runId})`);
    });
    await flips(vOther, false, async () => {
      await db.execute(
        sql`DELETE FROM issue_leases WHERE project_id = ${projectId} AND issue_key = 'ISS-5'`,
      );
    });

    // a run whose group comes to hold this issue, declared before the landing
    const later = await runSession(at(0), ['ISS-9'], { 'ISS-9': 'in_progress' });
    const vLater = await pass(at(6), later.sessionId);
    await flips(vLater, true, async () => {
      await db.execute(sql`
        UPDATE pipeline_runs SET metadata = metadata
          || ${JSON.stringify({ runGroup: ['ISS-5'], runIssueStatuses: { 'ISS-5': 'in_progress' } })}::jsonb
         WHERE id = ${later.runId}`);
    });

    // a run declared after the landing builds once a reopen sends the work back before it
    const rebuild = await runSession(at(8), ['ISS-5'], { 'ISS-5': 'in_progress' });
    const vRebuild = await pass(at(9), rebuild.sessionId);
    await flips(vRebuild, true, async () => {
      await db.execute(sql`
        INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type,
                                        actor_agency, actor_id, source, created_at)
        VALUES ('issue', ${issueId}, 'awaiting_release', 'reopen', 'user', 'human', ${ownerId},
                'test', ${at(7).toISOString()})`);
    });

    // a landing recorded after a run was declared over the work: it built it
    const landed = await runSession(at(10), ['ISS-5'], { 'ISS-5': 'in_progress' });
    const vLanded = await pass(at(11), landed.sessionId);
    await db.execute(sql`DELETE FROM kernel_transitions WHERE entity_id = ${issueId}`);
    await drainStaleBuilderFacts(db);
    await flips(vLanded, true, async () => {
      await db.execute(
        sql`UPDATE issues SET merged_at = ${at(12).toISOString()} WHERE id = ${issueId}`,
      );
    });

    // a box's verdict naming no session is the builder's while a building session was live on it
    const vBox = await pass(at(13), null);
    await flips(vBox, false, async () => {
      // a status moves only under the kernel's marker (0393), as `lifecycle/transition.ts` writes it
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`);
        await tx.execute(sql`
          UPDATE agent_sessions SET status = 'completed', updated_at = ${at(0).toISOString()}
           WHERE device_id = ${box}`);
      });
    });

    // a deleted session nulls its verdicts' session: the verdict is read by its box from then on
    const gone = await runSession(at(11), ['ISS-5'], { 'ISS-5': 'in_progress' });
    const vGone = await pass(at(15), gone.sessionId);
    await flips(vGone, false, async () => {
      await db.execute(sql`DELETE FROM agent_sessions WHERE id = ${gone.sessionId}`);
    });
  });

  it('is red where a write gets past the trigger: the rule moved and the model did not', async () => {
    const other = await runSession(at(4), ['ISS-9'], { 'ISS-9': 'in_progress' });
    const vOther = await pass(at(5), other.sessionId);
    await modelHolds();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`
        INSERT INTO issue_leases (project_id, issue_key, device_id, session_id, run_id)
        VALUES (${projectId}, 'ISS-5', ${box}, ${other.sessionId}, ${other.runId})`);
    });
    expect((await live()).get(vOther)).toBe(true);
    expect(await marked()).toBe(false);
    expect(await builderFactDrift(db, [issueId])).toEqual([
      {
        verdictId: vOther,
        issueId,
        stored: { byBuilder: false, declaredBeforeLanding: null },
        live: { byBuilder: true, declaredBeforeLanding: null },
      },
    ]);
    // the sweep finds it and reports it, and leaves it for the write that got past to be found
    const swept = await sweepBuilderFacts(db);
    expect(swept.drift.map((d) => d.verdictId)).toEqual([vOther]);
    expect(await builderFactDrift(db, [issueId])).toHaveLength(1);
  });

  it('writes on read a fact the model lost, rather than serving a verdict without one', async () => {
    const vOne = await pass(at(5), null);
    await modelHolds();
    // past the trigger, a verdict with no fact and no mark: the read writes it, as it does for any owed
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`DELETE FROM verdict_builder_facts WHERE verdict_id = ${vOne}`);
    });
    const read = await liveVerdictsOfIssues(db, [issueId]);
    expect(read.get(issueId)?.get(1)?.[0]?.id).toBe(vOne);
    expect(await builderFactDrift(db, [issueId])).toEqual([]);
  });
});

describe('the inputs the builder rule reads', () => {
  it('are each a table with its marking triggers on, and the rule reads no table beside them', async () => {
    const statement = new PgDialect().sqlToQuery(liveBuilderFactsSql([issueId])).sql;
    const read = new Set(
      [...statement.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)\b/gi)]
        .map((m) => m[1] as string)
        .filter((t) => !/^(lateral|unnest|jsonb_\w+)$/i.test(t)),
    );
    expect([...read].sort()).toEqual(BUILDER_INPUT_TABLES.map((t) => t.table).sort());
    const on = await rows<{ table: string; trigger: string }>(sql`
      SELECT c.relname AS table, t.tgname AS trigger FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname LIKE 'forge_builder_inputs_%' AND t.tgenabled <> 'D'`);
    const held = new Set(on.map((r) => `${r.table}.${r.trigger}`));
    const missing = BUILDER_INPUT_TABLES.flatMap(({ table, triggers }) =>
      triggers.filter((t) => !held.has(`${table}.${t}`)).map((t) => `${table}.${t}`),
    );
    expect(missing).toEqual([]);
  });
});
