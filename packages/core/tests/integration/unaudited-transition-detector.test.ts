/**
 * ISS-884 + ISS-943 — what a hand on the database produces, against real Postgres.
 *
 * The undercount this suite exists for cannot be reproduced with a mocked db:
 * it is a `psql` hand writing a status directly, which by definition reaches no
 * TypeScript this repo could stub. So every flip here runs as raw SQL on a real
 * connection, exactly as an operator would.
 *
 * The other direction — ordinary traffic producing NOTHING — is asserted just
 * as deliberately, in `unaudited-transition-ordinary-traffic.test.ts` and
 * `unaudited-transition-marker.test.ts`. A ruler that overcounts is as useless
 * as one that undercounts, so no arm here is trusted without its twin there.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUnauditedFixture, type UnauditedFixture } from '../helpers/unaudited-fixture.js';

describe('unaudited transitions: a hand on the database (ISS-884, ISS-943)', () => {
  let fx: UnauditedFixture;

  beforeAll(async () => {
    fx = await createUnauditedFixture();
  }, 60_000);
  afterAll(async () => {
    if (fx) await fx.harness.cleanup();
  });
  beforeEach(() => fx.reset());

  it('records a job terminal flip written by raw SQL, naming both statuses and the db role', async () => {
    const jobId = await fx.insertJob('running');

    await fx.harness.db.execute(sql`UPDATE jobs SET status = 'cancelled' WHERE id = ${jobId}`);

    const rows = await fx.detected();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity: 'job',
      entity_id: jobId,
      from_status: 'running',
      to_status: 'cancelled',
      issue_id: fx.ids.issueId,
    });
    expect(rows[0]?.db_user).toBeTruthy();
  });

  it('records a run terminal flip written by raw SQL', async () => {
    await fx.harness.db.execute(
      sql`UPDATE pipeline_runs SET status = 'cancelled' WHERE id = ${fx.ids.runId}`,
    );

    const rows = await fx.detected();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity: 'run',
      entity_id: fx.ids.runId,
      to_status: 'cancelled',
    });
  });

  // cm:why the `failed`→`queued` re-dispatch is one of the three interventions ISS-442's own discipline rule names, and it was uncounted until the marker reached the non-terminal writers — so this is the class-2 assertion, not a variation on the one above.
  it('records a hand-written NON-terminal re-dispatch', async () => {
    const jobId = await fx.insertJob('failed');

    await fx.harness.db.execute(sql`UPDATE jobs SET status = 'queued' WHERE id = ${jobId}`);

    const rows = await fx.detected();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity: 'job',
      entity_id: jobId,
      from_status: 'failed',
      to_status: 'queued',
    });
  });

  it('records a hand-written session flip, resolving its issue through the run', async () => {
    const sessionId = await fx.insertSession('running');

    await fx.harness.db.execute(
      sql`UPDATE agent_sessions SET status = 'completed' WHERE id = ${sessionId}`,
    );

    const rows = await fx.detected();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity: 'session',
      entity_id: sessionId,
      from_status: 'running',
      to_status: 'completed',
      issue_id: fx.ids.issueId,
    });
  });

  it('resolves a session under an issueless run through metadata.issueId, and records NULL for a malformed one', async () => {
    const pmRun = await fx.insertIssuelessRun();
    const chatSession = await fx.insertSession('running', {
      runId: pmRun,
      metadata: { issueId: fx.ids.issueId },
    });
    const bogusSession = await fx.insertSession('running', {
      runId: pmRun,
      metadata: { issueId: 'not-a-uuid' },
    });

    await fx.harness.db.execute(
      sql`UPDATE agent_sessions SET status = 'completed' WHERE id IN (${chatSession}, ${bogusSession})`,
    );

    const rows = await fx.detected();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.entity_id === chatSession)?.issue_id).toBe(fx.ids.issueId);
    expect(rows.find((r) => r.entity_id === bogusSession)?.issue_id).toBeNull();
  });

  it('records a hand-written DELETE on each kernel table, with the status the row held', async () => {
    const jobId = await fx.insertJob('running');
    const sessionId = await fx.insertSession('running');

    await fx.harness.db.execute(sql`DELETE FROM jobs WHERE id = ${jobId}`);
    await fx.harness.db.execute(sql`DELETE FROM agent_sessions WHERE id = ${sessionId}`);
    await fx.harness.db.execute(sql`DELETE FROM pipeline_runs WHERE id = ${fx.ids.runId}`);

    const rows = await fx.detected();
    expect(rows.map((r) => [r.entity, r.from_status, r.to_status])).toEqual([
      ['job', 'running', 'deleted'],
      ['session', 'running', 'deleted'],
      ['run', 'running', 'deleted'],
    ]);
  });

  it('surfaces every detected class in issue_intervention_events as direct_sql', async () => {
    const jobId = await fx.insertJob('running');
    const sessionId = await fx.insertSession('running');
    await fx.harness.db.execute(sql`UPDATE jobs SET status = 'failed' WHERE id = ${jobId}`);
    await fx.harness.db.execute(
      sql`UPDATE agent_sessions SET status = 'completed' WHERE id = ${sessionId}`,
    );
    await fx.harness.db.execute(sql`DELETE FROM jobs WHERE id = ${jobId}`);

    const rows = (await fx.harness.db.execute(sql`
    SELECT source, project_id, issue_id, detail
    FROM issue_intervention_events WHERE source = 'direct_sql'
  `)) as unknown as Array<{
      source: string;
      project_id: string;
      issue_id: string | null;
      detail: string | null;
    }>;

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.project_id).toBe(fx.ids.projectId);
      expect(row.issue_id).toBe(fx.ids.issueId);
    }
    const details = rows.map((r) => r.detail ?? '').join('\n');
    expect(details).toContain('job running→failed');
    expect(details).toContain('session running→completed');
    expect(details).toContain('job failed→deleted');
  });
});
