/**
 * Each issue's traced criteria kept per issue (ISS-1070 r7, 0633): after a write that moves one of
 * the live read's inputs, the stored facts either hold what the live read answers now or the issue
 * is marked, and a read never answers a marked issue's stored fact. Each write here is chosen to move
 * the answer, and the test checks it moved, so no step passes by moving nothing.
 *
 * Planted red: a verdict written with the input's trigger off (`session_replication_role = replica`,
 * the one way past it) leaves the stored fact as it was and the issue unmarked; the read then answers
 * the stored fact as current, and the drift sweep names the issue.
 *
 * @direct-test-of packages/core/src/requirements/criteria-facts.ts
 * @direct-test-of packages/core/src/requirements/criteria-facts-live.ts
 * @direct-test-of packages/core/src/requirements/standing-facts.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { drainStaleBuilderFacts } from '../../src/issues/builder-facts.js';
import {
  CRITERIA_FACT_INPUT_TABLES,
  criteriaFactDrift,
  drainStaleCriteriaFacts,
  storedIssueCriteria,
  sweepCriteriaFacts,
} from '../../src/requirements/criteria-facts.js';
import { liveIssueCriteria } from '../../src/requirements/criteria-facts-live.js';
import {
  createTestIssue,
  createTestProject,
  createTestRequirement,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';

const T0 = new Date('2026-11-01T08:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const SHA = 'd2dd9863e397c1b6b185bafdc06f9c7a88ee5589';

let ownerId: string;
let projectId: string;
let requirementId: string;
let issueId: string;
let criterionId: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  requirementId = (await createTestRequirement(projectId, 1, 'the page answers')).id;
  await db.execute(sql`
    INSERT INTO requirement_revisions
      (requirement_id, revision, state, spec, reason, author_id, author_agency, decided_by, decided_at)
    VALUES (${requirementId}, 1, 'current', '{}'::jsonb, 'first cut', ${ownerId}, 'human', ${ownerId}, now())`);
  const [bc] = await rows<{ id: string }>(sql`
    INSERT INTO requirement_criteria (requirement_id, code, body, since_revision)
    VALUES (${requirementId}, 'BC-1', 'the page answers', 1) RETURNING id`);
  issueId = (
    await createTestIssue(projectId, ownerId, 5, {
      status: 'in_progress',
      createdAt: T0,
      requirementId,
    })
  ).id;
  const [c] = await rows<{ id: string }>(sql`
    INSERT INTO issue_criteria (issue_id, n, statement, position, requirement_criterion_id)
    VALUES (${issueId}, 1, 'the page answers', 0, ${bc?.id}) RETURNING id`);
  criterionId = c?.id as string;
  await settle();
});

/** Every mark drained, builder facts first, so a read starts from facts the model holds. */
async function settle(): Promise<void> {
  while ((await drainStaleBuilderFacts(db, 200)) > 0);
  while ((await drainStaleCriteriaFacts(db, 200)) > 0);
}

/** A verdict on the issue's criterion, its evidence naming a file by name. */
async function verdict(v: 'pass' | 'fail', when: Date): Promise<void> {
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, identity_kind, commit_sha,
                                    author_agency, evidence, created_at)
    VALUES (${criterionId}, ${issueId}, ${v}, 'commit', ${SHA}, 'agent', ARRAY['shot.png'],
            ${when.toISOString()})`);
}

const marked = async () =>
  (
    await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM issue_criteria_facts_stale WHERE issue_id = ${issueId}`,
    )
  )[0]?.n === 1;

/** What the model answers for the issue, and what the live read answers, as JSON. */
async function both(): Promise<{ stored: unknown; live: unknown }> {
  const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;
  return {
    stored: json(await storedIssueCriteria([issueId])),
    live: json(await liveIssueCriteria([issueId], db, [])),
  };
}

describe('the criteria facts each write keeps (ISS-1070 r7)', () => {
  it('holds, after a backfill, what the live read answers', async () => {
    await verdict('pass', at(5));
    await db.execute(sql`DELETE FROM issue_criteria_facts`);
    await db.execute(sql`INSERT INTO issue_criteria_facts_stale (issue_id, cause)
                         VALUES (${issueId}, 'backfill') ON CONFLICT DO NOTHING`);
    expect(await drainStaleCriteriaFacts(db, 200)).toBe(1);
    expect(await marked()).toBe(false);
    const { stored, live } = await both();
    expect(stored).toEqual(live);
    expect((stored as { verdict: string }[])[0]?.verdict).toBe('pass');
  });

  it('marks the issue on a verdict, so a read answers the new verdict, never the stored one', async () => {
    await verdict('pass', at(5));
    expect((await storedIssueCriteria([issueId]))[0]?.verdict).toBe('pass');
    expect(await marked()).toBe(false);
    // a verdict written by raw SQL, past every door: its trigger marks the issue all the same
    await verdict('fail', at(9));
    expect(await marked()).toBe(true);
    expect((await storedIssueCriteria([issueId]))[0]?.verdict).toBe('fail');
    expect(await marked()).toBe(false);
    const { stored, live } = await both();
    expect(stored).toEqual(live);
  });

  it('marks the issue on a file its evidence names, so a read answers the file, never the stored fact', async () => {
    await verdict('pass', at(5));
    const files = async () =>
      ((await storedIssueCriteria([issueId]))[0]?.files ?? []).map((f) => f.name);
    expect(await files()).toEqual([]);
    // only this model's trigger marks an attachment: the builder rule reads none
    await db.execute(sql`
      INSERT INTO issue_attachments (issue_id, uploader_id, name, path, mime, size)
      VALUES (${issueId}, ${ownerId}, 'shot.png', 'k/shot.png', 'image/png', 1)`);
    expect(await marked()).toBe(true);
    expect(await files()).toEqual(['shot.png']);
    expect(await marked()).toBe(false);
  });

  it('marks the issue on a criterion moved, a reopen and a baseline agreed', async () => {
    await verdict('pass', at(5));
    await storedIssueCriteria([issueId]);
    const moves = [
      sql`UPDATE issue_criteria SET position = 1 WHERE id = ${criterionId}`,
      sql`INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, source)
          VALUES ('issue', ${issueId}, 'in_progress', 'reopen', 'system', 'agent', 'test')`,
      sql`INSERT INTO requirement_baselines (requirement_id, revision, seq, agreed_by)
          VALUES (${requirementId}, 1, 1, ${ownerId})`,
    ];
    for (const move of moves) {
      expect(await marked()).toBe(false);
      await db.execute(move);
      expect(await marked()).toBe(true);
      await storedIssueCriteria([issueId]);
    }
    const { stored, live } = await both();
    expect(stored).toEqual(live);
  });

  it('is red where a write gets past the trigger: the stored fact is read as current', async () => {
    await verdict('pass', at(5));
    expect((await storedIssueCriteria([issueId]))[0]?.verdict).toBe('pass');
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`
        INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, identity_kind, commit_sha,
                                        author_agency, created_at)
        VALUES (${criterionId}, ${issueId}, 'fail', 'commit', ${SHA}, 'agent', ${at(9).toISOString()})`);
    });
    expect(await marked()).toBe(false);
    // no mark, so the model answers what it holds: what the trigger exists to prevent
    expect((await storedIssueCriteria([issueId]))[0]?.verdict).toBe('pass');
    const drift = await criteriaFactDrift(db, [issueId]);
    expect(drift.map((d) => d.issueId)).toEqual([issueId]);
    // the sweep finds it and reports it, and leaves it for the write that got past to be found
    const swept = await sweepCriteriaFacts(db);
    expect(swept.drift.map((d) => d.issueId)).toEqual([issueId]);
    expect(await criteriaFactDrift(db, [issueId])).toHaveLength(1);
  });

  it('writes on read a fact the model lost, rather than answering no criteria', async () => {
    await verdict('pass', at(5));
    await storedIssueCriteria([issueId]);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`DELETE FROM issue_criteria_facts WHERE issue_id = ${issueId}`);
    });
    expect((await storedIssueCriteria([issueId]))[0]?.verdict).toBe('pass');
    expect(await criteriaFactDrift(db, [issueId])).toEqual([]);
  });
});

describe('the inputs the live read reads', () => {
  it('are each a table with its marking triggers on, and the live read reads no table beside them', async () => {
    await verdict('pass', at(5));
    // the builder flags written first, so the live read sends only its own statements
    await settle();
    const client = (db as unknown as { $client: { unsafe: (...a: unknown[]) => unknown } }).$client;
    const sent: string[] = [];
    const unsafe = client.unsafe;
    client.unsafe = (...a: unknown[]) => {
      sent.push(String(a[0]));
      return unsafe(...a);
    };
    try {
      await liveIssueCriteria([issueId], db, []);
    } finally {
      client.unsafe = unsafe;
    }
    const ctes = new Set(
      sent.flatMap((s) =>
        [...s.matchAll(/\b([a-z_]+)\s+AS\s+(?:MATERIALIZED\s+)?\(/gi)].map((m) => m[1]),
      ),
    );
    const read = new Set(
      sent
        .flatMap((s) =>
          [...s.matchAll(/\b(?:FROM|JOIN)\s+"?([a-z_]+)"?/gi)].map((m) => m[1] as string),
        )
        .filter((t) => !ctes.has(t) && !/^(lateral|unnest|jsonb_\w+)$/i.test(t)),
    );
    // the builder marks are read as owed by `criteria-facts.ts:heldOf` itself, not through a trigger
    read.delete('issue_read_model_stale');
    expect([...read].sort()).toEqual(CRITERIA_FACT_INPUT_TABLES.map((t) => t.table).sort());
    const on = await rows<{ table: string; trigger: string }>(sql`
      SELECT c.relname AS table, t.tgname AS trigger FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname LIKE 'forge_criteria_facts_%' AND t.tgenabled <> 'D'`);
    const held = new Set(on.map((r) => `${r.table}.${r.trigger}`));
    const missing = CRITERIA_FACT_INPUT_TABLES.flatMap(({ table, triggers }) =>
      triggers.filter((t) => !held.has(`${table}.${t}`)).map((t) => `${table}.${t}`),
    );
    expect(missing).toEqual([]);
  });
});
