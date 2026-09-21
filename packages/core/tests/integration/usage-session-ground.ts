import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import type { TestDb } from '../helpers/index.js';
import { createTestProject, createTestProjectMember, createTestUser } from '../helpers/index.js';

export const RUNS = 5_000;
export const SESSIONS = 16_000;
export const JOBS = 8_000;
export const ISSUES = 2_000;
export const USAGE_ROWS = 24_000;

/** Deterministic uuids so a selection can be written without reading ids back. */
const node = (g: number) => `ab${g.toString(16).padStart(10, '0')}`;
export const runId = (g: number) => `20000000-0000-4000-8000-${node(g)}`;
export const sessionId = (g: number) => `10000000-0000-4000-8000-${node(g)}`;
export const issueId = (g: number) => `30000000-0000-4000-8000-${node(g)}`;

/** The fixture, seeded once. Kept out of the describe body so the suite stays inside the
 *  per-function line budget rather than buying an exemption from it. */
export async function seedFixture(db: TestDb, projectId: string, ownerId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    SELECT ('30000000-0000-4000-8000-ab' || lpad(to_hex(g), 10, '0'))::uuid,
           ${projectId}, g, 'seeded ' || g, 'open', ${ownerId}
    FROM generate_series(1, ${ISSUES}) g`);

  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
    SELECT ('20000000-0000-4000-8000-ab' || lpad(to_hex(g), 10, '0'))::uuid,
           ${projectId}, 'system', 'running', now() - (g * interval '1 minute')
    FROM generate_series(1, ${RUNS}) g`);

  await db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, pipeline_run_id, kind, status, started_at, metadata)
    SELECT ('10000000-0000-4000-8000-ab' || lpad(to_hex(g), 10, '0'))::uuid, ${projectId},
           ('20000000-0000-4000-8000-ab' || lpad(to_hex(((g - 1) % ${RUNS}) + 1), 10, '0'))::uuid,
           'pipeline', 'idle', now() - (g * interval '1 second'),
           -- metadata.issueId maps sessions onto the same 2,000 issues the jobs use, so
           -- estimateIssueContextTokens has a real selection to be planned against.
           jsonb_build_object('issueId',
             '30000000-0000-4000-8000-ab' || lpad(to_hex(((g - 1) % ${ISSUES}) + 1), 10, '0'))
    FROM generate_series(1, ${SESSIONS}) g`);

  await db.execute(sql`
    INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status,
                      agent_session_id, dispatched_at, finished_at, model_used)
    SELECT ('40000000-0000-4000-8000-ab' || lpad(to_hex(g), 10, '0'))::uuid, ${projectId},
           ('30000000-0000-4000-8000-ab' || lpad(to_hex(((g - 1) % ${ISSUES}) + 1), 10, '0'))::uuid,
           ('20000000-0000-4000-8000-ab' || lpad(to_hex(((g - 1) % ${RUNS}) + 1), 10, '0'))::uuid,
           ${ownerId}, 'plan',
           (ARRAY['done','failed','cancelled'])[(g % 3) + 1]::text,
           ('10000000-0000-4000-8000-ab' || lpad(to_hex(g), 10, '0'))::uuid,
           now() - (g * interval '1 second'),
           CASE WHEN g % 500 = 0 THEN now() - (g * interval '1 second') - interval '5 second'
                ELSE now() - (g * interval '1 second') + interval '30 second' END,
           'claude-opus-4-7'
    FROM generate_series(1, ${JOBS}) g`);

  // Two more shapes the view has to carry unchanged: a job with no session at
  // all, and a job whose session exists but has produced no usage row.
  await db.execute(sql`
    INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status,
                      agent_session_id, dispatched_at, finished_at, model_used)
    SELECT ('50000000-0000-4000-8000-ab' || lpad(to_hex(g), 10, '0'))::uuid, ${projectId}, NULL,
           ('20000000-0000-4000-8000-ab' || lpad(to_hex(g), 10, '0'))::uuid, ${ownerId}, 'plan',
           'done',
           CASE WHEN g % 2 = 0 THEN NULL
                ELSE ('10000000-0000-4000-8000-ab' || lpad(to_hex(${SESSIONS} + g), 10, '0'))::uuid END,
           now() - interval '1 hour', now() - interval '30 minute', NULL
    FROM generate_series(1, 200) g`);

  // 24,000 rows over the 16,000 sessions, written in two ascending passes so a
  // session's rows land together the way they accrue on the deployment.
  for (const [count, tag] of [
    [SESSIONS, 'first'],
    [USAGE_ROWS - SESSIONS, 'second'],
  ] as Array<[number, string]>) {
    await db.execute(sql`
      INSERT INTO usage_records (id, project_id, source, model, input_tokens, output_tokens,
                                 estimated_cost, request_count, session_id, recorded_at)
      SELECT gen_random_uuid(), ${projectId}, 'cli', 'claude-opus-4-7', 100 + g, 10 + g,
             (g % 97)::real / 1000.0, 1,
             '10000000-0000-4000-8000-ab' || lpad(to_hex(g), 10, '0'),
             now() - (g * interval '1 second') - ${sql.raw(`interval '${tag === 'first' ? 0 : 1} hour'`)}
      FROM generate_series(1, ${count}) g`);
  }

  await db.execute(sql`ANALYZE`);
}

/** What every index-served assertion here means, in one place. */
export function expectIndexServed(text: string) {
  expect(text).toContain('usage_records_session_id_idx');
  expect(text).not.toContain('Seq Scan on usage_records');
}

/**
 * A verified owner who is a member of a fresh project — what the mounted router's
 * auth needs before it will answer a cost read at all.
 */
export async function seedOwnerProject(db: TestDb): Promise<{ userId: string; projectId: string }> {
  const user = await createTestUser(db);
  await db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(db, user.id);
  await createTestProjectMember(db, { userId: user.id, projectId: project.id, role: 'member' });
  return { userId: user.id, projectId: project.id };
}

/** The plan Postgres chose for `query`, as EXPLAIN prints it. */
export async function explain(db: TestDb, query: ReturnType<typeof sql>): Promise<string> {
  const rows = await db.execute<Record<string, string>>(sql`EXPLAIN (COSTS OFF) ${query}`);
  return [...rows].map((r) => Object.values(r)[0]).join('\n');
}
