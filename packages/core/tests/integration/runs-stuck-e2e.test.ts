// cm:why stuck is read back through the real routes on real Postgres (ISS-109): each fixture backdates the one
// clock its rule reads, since only time makes a run silent, and a beat through the session route clears it

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  app,
  deviceId,
  harness,
  issue,
  type Json,
  jobRun,
  list,
  one,
  openRun,
  ownerId,
  projectId,
  registerRunsWorld,
  signUserToken,
} from '../helpers/runs-world.js';

registerRunsWorld();

async function backdate(run: { sessionId: string; runId: string }, minutes: number) {
  const then = new Date(Date.now() - minutes * 60_000).toISOString();
  await harness.db.execute(sql`
    UPDATE pipeline_runs SET started_at = ${then}::timestamptz - interval '1 second'
     WHERE id = ${run.runId}`);
  await harness.db.execute(sql`
    UPDATE agent_sessions SET last_heartbeat_at = ${then}::timestamptz,
           started_at = ${then}::timestamptz, created_at = ${then}::timestamptz
     WHERE id = ${run.sessionId}`);
}

async function ledger(run: { sessionId: string; runId: string }, incarnation: string) {
  const { handleRunnerSessions } = await import('../../src/devices/run-ledger-ws.js');
  await handleRunnerSessions({ principal: { type: 'device', deviceId } } as never, {
    data: {
      bootId: 'boot-1',
      runs: [
        {
          runId: randomUUID(),
          projectId,
          sessionId: run.sessionId,
          worktreePath: '/w/run',
          bootId: 'boot-1',
          incarnation,
          work: 'runnable',
          issues: [],
        },
      ],
    },
  });
}

describe('stuck, computed in core (ISS-109)', () => {
  it('a run session silent past 3 min reads stuck silent naming its session row, and a beat reads running again', async () => {
    await issue(1, 'in_progress');
    const run = await openRun(1);
    await backdate(run, 4);
    const stuck = await one(run.runId);
    expect(stuck.state).toBe('stuck');
    expect(stuck.stuck).toMatchObject({
      source: 'stuck',
      rule: 'silent',
      evidence: { table: 'agent_sessions', id: run.sessionId, column: 'last_heartbeat_at' },
    });
    expect(Date.parse(stuck.stuck.failsAt) - Date.parse(stuck.stuck.evidence.at)).toBe(10 * 60_000);
    const listed = await list('live');
    expect(listed.counts.liveByState.stuck).toBe(1);
    expect(listed.items.find((r: Json) => r.id === run.runId)?.state).toBe('stuck');

    const owner = {
      Authorization: `Bearer ${await signUserToken(ownerId)}`,
      'Content-Type': 'application/json',
    };
    const beat = await app.request(`/api/agent-sessions/${run.sessionId}`, {
      method: 'PATCH',
      headers: owner,
      body: JSON.stringify({ usage: { turns: 1 } }),
    });
    expect(beat.status, await beat.clone().text()).toBe(200);
    const back = await one(run.runId);
    expect(back.state).toBe('running');
    expect(back.stuck.source).toBe('clear');
  });

  it('lease_expired: the claim on the issue lapsed while the run session still beats', async () => {
    const id = await issue(1, 'in_progress');
    const run = await openRun(1);
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET started_at = now() - interval '30 minutes' WHERE id = ${run.runId}`);
    await harness.db.execute(sql`
      INSERT INTO issue_work_state (issue_id, lease)
      VALUES (${id}, ${JSON.stringify({
        holder: 'dev-run-1',
        renewedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        minutes: 10,
      })}::jsonb)
      ON CONFLICT (issue_id) DO UPDATE SET lease = EXCLUDED.lease`);
    const r = await one(run.runId);
    expect(r.state).toBe('stuck');
    expect(r.stuck).toMatchObject({
      rule: 'lease_expired',
      evidence: { table: 'issue_work_state', id: 'ISS-1', column: 'lease' },
    });
  });

  it('disagreement box-exited-core-running: the box ledger says exited while core runs the session', async () => {
    await issue(1, 'in_progress');
    const run = await openRun(1);
    await ledger(run, 'exited');
    const r = await one(run.runId);
    expect(r.stuck).toMatchObject({
      rule: 'disagreement',
      disagreement: 'box-exited-core-running',
      evidence: { table: 'device_run_ledger', id: run.sessionId, value: 'exited' },
    });
  });

  it('stranded: the idle-issues finding on the issue makes a live run stuck', async () => {
    const id = await issue(1, 'in_progress');
    const run = await openRun(1);
    const at = new Date(Date.now() - 60_000).toISOString();
    await harness.db.execute(sql`
      UPDATE issues SET session_context = ${JSON.stringify({
        strand: { at, status: 'in_progress', reason: 'claim malformed past grace' },
      })}::jsonb WHERE id = ${id}`);
    const r = await one(run.runId);
    expect(r.stuck).toMatchObject({
      rule: 'stranded',
      since: at,
      evidence: { table: 'issues', id: 'ISS-1', column: 'session_context.strand' },
    });
  });

  it('overdue: a verify_unavailable hold past its recheck by 3 min', async () => {
    const heldAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const gate = await jobRun(await issue(1), {
      status: 'held',
      payload: { __hold: { reason: 'verify_unavailable', heldAt, autoRelease: true } },
    });
    const r = await one(gate.runId);
    expect(r.state).toBe('stuck');
    expect(r.stuck).toMatchObject({
      rule: 'overdue',
      evidence: { table: 'jobs', id: gate.jobId, value: 'verify_unavailable' },
    });
  });

  it('a person wait stays waiting_person however long the run is silent', async () => {
    const id = await issue(1, 'in_progress');
    const run = await openRun(1);
    await backdate(run, 30);
    await harness.db.execute(sql`
      INSERT INTO agent_questions (id, project_id, issue_id, agent_session_id, status, blocker_kind, steps)
      VALUES (${randomUUID()}, ${projectId}, ${id}, ${run.sessionId}, 'open', 'human', '[]'::jsonb)`);
    const r = await one(run.runId);
    expect(r.state).toBe('waiting_person');
    expect(r.stuck.source).toBe('clear');
  });
  it('the one-shot sweep leaves a silent run session stuck until its 10 min reap, even on a box nobody sees', async () => {
    const { reapOrphanedOneShotRuns } = await import('../../src/pipeline/sweeper.js');
    await issue(1, 'in_progress');
    const run = await openRun(1);
    await harness.db.execute(
      sql`UPDATE runners SET last_seen_at = NULL WHERE device_id = ${deviceId}`,
    );
    await backdate(run, 4);
    expect((await reapOrphanedOneShotRuns(new Date())).reaped).toBe(0);
    expect((await one(run.runId)).state).toBe('stuck');
    await backdate(run, 11);
    expect((await reapOrphanedOneShotRuns(new Date())).reaped).toBe(1);
    expect((await one(run.runId)).state).toBe('failed');
  });
});
