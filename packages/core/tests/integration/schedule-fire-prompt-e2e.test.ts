// cm:why ISS-112 (design automation rev 1, steps tick, route, skipped, agent_runs and settle;
// REQ-16 BC-1): every prompt fire writes exactly one schedule_runs row that carries its session,
// says why when it ran nothing, settles when its session stops whoever stops it, and survives a
// failover as the same row, driven through the mounted app, the ticker and real Postgres.

import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import {
  adminBearer,
  boxPairedBy,
  call,
  createSchedule,
  g,
  onlyFire,
  scheduleRow,
  sessionRow,
  tick,
  useFireGround,
} from './schedule-fire-ground.js';

const ONE_SHOT_KEY = 'fire-test-one-shot';

vi.mock('../../src/schedules/messages/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/schedules/messages/registry.js')>();
  const oneShot = {
    key: ONE_SHOT_KEY,
    title: 'A one-shot message for the fire test',
    message: 'Apply the one-shot guidance once.',
    rationale: 'Exercises the already-applied route of a prompt fire.',
    category: 'general' as const,
    version: 1,
    recommended: false,
    defaultMode: 'propose' as const,
  };
  return {
    ...actual,
    getImprovementMessage: (key: string) =>
      key === ONE_SHOT_KEY ? oneShot : actual.getImprovementMessage(key),
  };
});

useFireGround();

describe('a prompt fire that reaches a box', () => {
  it('writes one running row carrying its session, and the session names the fire', async () => {
    const scheduleId = await createSchedule({ prompt: 'tidy the backlog' });
    await tick(scheduleId);

    const fire = await onlyFire(scheduleId);
    expect(fire).toMatchObject({ trigger: 'scheduled', status: 'running', reason: null });
    expect(fire.finishedAt).toBeNull();
    const session = await sessionRow(fire.sessionId as string);
    expect(fire.pipelineRunId).toBe(session.pipelineRunId);
    expect((session.metadata as Record<string, unknown>).scheduleRunId).toBe(fire.id);
    expect((await scheduleRow(scheduleId)).lastStatus).toBe('running');
  });

  it('settles success when its session completes, and last_status reads the fire', async () => {
    const scheduleId = await createSchedule({ prompt: 'tidy the backlog' });
    await tick(scheduleId);
    const { sessionId } = await onlyFire(scheduleId);

    const res = await call('PATCH', `/api/agent-sessions/${sessionId}`, g.boxToken, {
      status: 'completed',
      toolCallCount: 3,
    });
    expect(res.status).toBe(200);

    const fire = await onlyFire(scheduleId);
    expect(fire).toMatchObject({ status: 'success', error: null, refusal: null });
    expect(fire.finishedAt).not.toBeNull();
    expect((await scheduleRow(scheduleId)).lastStatus).toBe('success');
  });

  it('settles failed with the reason when a run read nothing (audit_ran_blind)', async () => {
    const scheduleId = await createSchedule({ prompt: 'tidy the backlog' });
    await tick(scheduleId);
    const { sessionId } = await onlyFire(scheduleId);

    await call('PATCH', `/api/agent-sessions/${sessionId}`, g.boxToken, {
      status: 'completed',
      toolCallCount: 0,
    });

    const fire = await onlyFire(scheduleId);
    expect(fire.status).toBe('failed');
    expect(fire.error).toMatch(/^audit_ran_blind/);
    expect((await scheduleRow(scheduleId)).lastStatus).toBe('failed');
  });

  it('settles failed when a sweeper writes the session directly, not only through a route', async () => {
    const scheduleId = await createSchedule({ prompt: 'tidy the backlog' });
    await tick(scheduleId);
    const { sessionId } = await onlyFire(scheduleId);

    await g.harness.db.execute(
      sql`UPDATE agent_sessions SET status = 'cancelled_stale' WHERE id = ${sessionId}`,
    );

    const fire = await onlyFire(scheduleId);
    expect(fire).toMatchObject({ status: 'failed', error: 'session cancelled_stale' });
  });

  it('settles failed when its session is deleted under it', async () => {
    const scheduleId = await createSchedule({ prompt: 'tidy the backlog' });
    await tick(scheduleId);
    const { sessionId } = await onlyFire(scheduleId);

    await g.harness.db.execute(sql`DELETE FROM agent_sessions WHERE id = ${sessionId}`);

    const fire = await onlyFire(scheduleId);
    expect(fire).toMatchObject({ status: 'failed', error: 'session deleted', sessionId: null });
  });
});

describe('a prompt fire that ran nothing says why on its row', () => {
  it('a manual run with no box online: skipped, no-device, and the 409 names the fire', async () => {
    await g.harness.db.execute(sql`DELETE FROM runners`);
    const scheduleId = await createSchedule({ prompt: 'tidy the backlog' });

    const res = await call('POST', `/api/schedules/${scheduleId}/run`, await adminBearer());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; details?: unknown };
    expect(body.code).toBe('SCHEDULE_DISPATCH_FAILED');

    const fire = await onlyFire(scheduleId);
    expect(fire).toMatchObject({
      trigger: 'manual',
      status: 'skipped',
      reason: 'no-device',
      sessionId: null,
    });
    expect(fire.finishedAt).not.toBeNull();
    expect((await scheduleRow(scheduleId)).lastStatus).toBe('skipped');
  });

  it('a target project that is gone: skipped, project-not-found', async () => {
    const scheduleId = await createSchedule({ prompt: 'tidy the backlog' });
    await g.harness.db
      .update(g.m.schema.schedules)
      .set({ targetProjectSlug: 'a-project-nobody-has' })
      .where(eq(g.m.schema.schedules.id, scheduleId));
    await tick(scheduleId);

    expect(await onlyFire(scheduleId)).toMatchObject({
      status: 'skipped',
      reason: 'project-not-found',
    });
  });

  it('a one-shot template already applied: skipped, already-applied', async () => {
    const scheduleId = await createSchedule({ prompt: 'unused', templateKey: ONE_SHOT_KEY });
    await g.harness.db
      .update(g.m.schema.schedules)
      .set({ appliedMessageVersions: { [ONE_SHOT_KEY]: 1 } })
      .where(eq(g.m.schema.schedules.id, scheduleId));
    await tick(scheduleId);

    expect(await onlyFire(scheduleId)).toMatchObject({
      status: 'skipped',
      reason: 'already-applied',
    });
  });

  it('a templateKey the registry no longer holds: failed, never read as already-applied', async () => {
    const scheduleId = await createSchedule({ prompt: 'unused', templateKey: ONE_SHOT_KEY });
    await g.harness.db
      .update(g.m.schema.schedules)
      .set({ templateKey: 'a-retired-message' })
      .where(eq(g.m.schema.schedules.id, scheduleId));
    await tick(scheduleId);

    const fire = await onlyFire(scheduleId);
    expect(fire).toMatchObject({ status: 'failed', reason: null, sessionId: null });
    expect(fire.error).toBe(
      "templateKey 'a-retired-message' names no registered improvement message, so this fire has no prompt to send",
    );
  });

  it('a run-as identity refused: failed with the refusal code, on the session it opened', async () => {
    await g.harness.db.execute(sql`UPDATE devices SET capabilities = '{}'::jsonb`);
    const scheduleId = await createSchedule({ prompt: 'tidy the backlog' });
    await tick(scheduleId);

    const fire = await onlyFire(scheduleId);
    expect(fire).toMatchObject({ status: 'failed', refusal: 'RUNNER_OUTDATED' });
    expect(fire.error).toMatch(/^session_authority_refused: RUNNER_OUTDATED: /);
    expect((await sessionRow(fire.sessionId as string)).status).toBe('failed');
    expect((await scheduleRow(scheduleId)).lastStatus).toBe('failed');
  });

  it('an owner whose account is gone: failed, SCHEDULE_OWNER_GONE', async () => {
    const scheduleId = await createSchedule({ prompt: 'tidy the backlog' });
    await g.harness.db
      .update(g.m.schema.schedules)
      .set({ ownerId: null })
      .where(eq(g.m.schema.schedules.id, scheduleId));
    await tick(scheduleId);

    expect(await onlyFire(scheduleId)).toMatchObject({
      status: 'failed',
      refusal: 'SCHEDULE_OWNER_GONE',
    });
  });
});

describe('a failover keeps the fire', () => {
  async function failedFire() {
    const scheduleId = await createSchedule({ prompt: 'tidy the backlog' });
    await tick(scheduleId);
    const { sessionId } = await onlyFire(scheduleId);
    const res = await call('PATCH', `/api/agent-sessions/${sessionId}`, g.boxToken, {
      status: 'failed',
    });
    expect(res.status).toBe(200);
    expect((await onlyFire(scheduleId)).status).toBe('failed');
    return { scheduleId, failedSessionId: sessionId as string };
  }

  it('a re-dispatch hands the one row to the retry, which then settles it', async () => {
    const { scheduleId, failedSessionId } = await failedFire();
    const second = await boxPairedBy(g.adminId, { turnCredential: true });

    const result = await g.m.failover.redispatchScheduleSessionOnFailover(failedSessionId);
    expect(result).toMatchObject({ ok: true, deviceId: second.id });
    const retryId = result.ok ? result.sessionId : '';

    const moved = await onlyFire(scheduleId);
    expect(moved).toMatchObject({ sessionId: retryId, status: 'running', error: null });
    expect(moved.disposition).toBe(`cross-device failover (re-dispatched to device ${second.id})`);
    expect((await sessionRow(retryId)).metadata).toMatchObject({ scheduleRunId: moved.id });

    await call('PATCH', `/api/agent-sessions/${retryId}`, second.token, {
      status: 'completed',
      toolCallCount: 2,
    });
    expect(await onlyFire(scheduleId)).toMatchObject({ status: 'success' });
    expect((await scheduleRow(scheduleId)).lastStatus).toBe('success');
  });

  it('no other box: the row stays failed and says why the run was not re-dispatched', async () => {
    const { scheduleId, failedSessionId } = await failedFire();

    const result = await g.m.failover.redispatchScheduleSessionOnFailover(failedSessionId);
    expect(result).toMatchObject({ ok: false, status: 'no-device' });

    expect(await onlyFire(scheduleId)).toMatchObject({
      status: 'failed',
      sessionId: failedSessionId,
      disposition: 'no failover (no other device was available)',
    });
  });

  it('a run that already did work is not re-dispatched, and its alert carries the fire', async () => {
    const { scheduleId, failedSessionId } = await failedFire();
    await g.harness.db.execute(
      sql`UPDATE agent_sessions SET claude_session_id = 'claude-1',
            metadata = metadata || '{"toolCallCount": 4}'::jsonb
          WHERE id = ${failedSessionId}`,
    );

    const result = await g.m.failover.redispatchScheduleSessionOnFailover(failedSessionId);
    expect(result).toMatchObject({ ok: false, status: 'side-effects' });

    const fire = await onlyFire(scheduleId);
    expect(fire.disposition).toMatch(/^no failover \(session had attached/);
    const alerts = await g.harness.db
      .select()
      .from(g.m.schema.notifications)
      .where(
        and(
          eq(g.m.schema.notifications.type, 'schedule_report'),
          eq(g.m.schema.notifications.agentSessionId, failedSessionId),
        ),
      );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.scheduleRunId).toBe(fire.id);
  });
});
