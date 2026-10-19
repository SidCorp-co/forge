import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestDevice } from '../helpers/factories.js';
import { registerIdleFixture, testLease } from '../helpers/idle-fixture.js';

/**
 * ISS-1228 — one project's live sessions and what is held on it, against a live database. Each
 * thing that must appear is seeded beside the thing that looks like it and must not.
 */
const fx = registerIdleFixture(1700);
const NOW = new Date('2026-09-20T16:00:00.000Z');

async function read() {
  const { readSessionsAndHolds } = await import('../../src/pipeline/sessions-and-holds.js');
  return readSessionsAndHolds(fx.projectId, NOW);
}

async function session(kind: string, status: string): Promise<string> {
  const id = randomUUID();
  const device = await createTestDevice(fx.db, fx.ownerId);
  const runId = await fx.seedRun(null, 'running');
  await fx.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, title,
                                runtime_state)
    VALUES (${id}, ${fx.projectId}, ${device.id}, ${runId}, ${kind}, ${status},
            ${`${kind} ${status}`}, 'working')
  `);
  return id;
}

async function moved(issueId: string, from: string, to: string, reason: string | null) {
  await fx.db.execute(sql`
    INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, reason, actor_type,
                                    actor_id, source, created_at)
    VALUES ('issue', ${issueId}, ${from}, ${to}, ${reason}, 'user', ${fx.ownerId}, 'issues',
            now() - interval '5 minutes')
  `);
}

const parkRecord = [
  '## Park',
  '',
  '```forge-record',
  'kind: question',
  'why: which of the two readings ships',
  'left: in_progress',
  '```',
  '',
  '`forge-record: park · contract 1`',
].join('\n');

describe('readSessionsAndHolds — sessions (ISS-1228)', () => {
  it('lists a running session and leaves out an ended one and a chat', async () => {
    const live = await session('run_session', 'running');
    await session('run_session', 'completed');
    await session('chat', 'running');
    const out = await read();
    expect(out.sessions.map((s) => s.id)).toEqual([live]);
  });

  it('answers a chat whose turn is running, with its box, and no idle or ended chat', async () => {
    const running = await session('chat', 'running');
    await session('chat', 'idle');
    await session('chat', 'completed');
    await session('run_session', 'running');
    const out = await read();
    const [box] = (await fx.db.execute(sql`
      SELECT device_id FROM agent_sessions WHERE id = ${running}
    `)) as unknown as Array<{ device_id: string }>;
    expect(out.runningChats).toEqual([{ id: running, deviceId: box?.device_id }]);
    expect(out.sessions.map((s) => s.kind)).toEqual(['run_session']);
  });

  // Round 16: the dashboard counts a chat whose turn is running as live, so the rail counts it too.
  it('counts for the rail and the console the sessions it lists and the running chats, not the runs left open', async () => {
    await session('run_session', 'running');
    await session('run_session', 'completed');
    await session('chat', 'running');
    await session('chat', 'idle');
    const { readLiveSessionCounts } = await import('../../src/pipeline/live-session.js');
    const counts = await readLiveSessionCounts([fx.projectId]);
    const out = await read();
    const [openRuns] = (await fx.db.execute(sql`
      SELECT count(*)::int AS n FROM pipeline_runs WHERE project_id = ${fx.projectId} AND status = 'running'
    `)) as unknown as Array<{ n: number }>;
    expect(openRuns?.n).toBe(4);
    expect(counts).toEqual([
      { projectId: fx.projectId, n: out.sessions.length + out.runningChats.length },
    ]);
    expect(out.sessions).toHaveLength(1);
    expect(out.runningChats).toHaveLength(1);
    // Round 16: the dashboard counts the runs it lists from the runs these sessions name.
    const [own] = (await fx.db.execute(sql`
      SELECT pipeline_run_id::text AS run FROM agent_sessions WHERE id = ${out.sessions[0]?.id ?? ''}
    `)) as unknown as Array<{ run: string | null }>;
    expect(own?.run).toBeTruthy();
    expect(out.sessions[0]?.pipelineRunId).toBe(own?.run);
  });

  it('gives a session the issue its lease names, and that issue a session hold', async () => {
    const issueId = await fx.seedIssue({ status: 'in_progress' });
    await fx.seedIssueLease(fx.lastSeq, 'running');
    const out = await read();
    expect(out.sessions[0]?.issues.map((i) => i.issueId)).toEqual([issueId]);
    expect(out.holds).toHaveLength(1);
    expect(out.holds[0]?.holders[0]?.by).toBe('session');
  });

  // ISS-1228 r9: the Pipeline page said "No issue held" for a step session the issue page showed
  // running that issue. A job's session is bound to its issue by `metadata.issueId` — the bind
  // pipeline-health reads — and no issue lease.
  it("gives a step session the issue its job works, and that issue the session's hold", async () => {
    const issueId = await fx.seedIssue({ status: 'in_progress' });
    const step = await session('pipeline', 'running');
    await fx.db.execute(sql`
      UPDATE agent_sessions SET metadata = jsonb_build_object('issueId', ${issueId}::text, 'jobType', 'drive')
       WHERE id = ${step}
    `);
    const out = await read();
    expect(out.sessions.find((s) => s.id === step)?.issues.map((i) => i.issueId)).toEqual([
      issueId,
    ]);
    expect(out.holds.map((h) => h.issueId)).toEqual([issueId]);
    expect(out.holds[0]?.holders).toMatchObject([
      { by: 'session', sessionId: step, sessionKind: 'pipeline' },
    ]);
  });

  it('names a run session and its lease once, where it also records the issue', async () => {
    const issueId = await fx.seedIssue({ status: 'in_progress' });
    await fx.seedIssueLease(fx.lastSeq, 'running');
    await fx.db.execute(sql`
      UPDATE agent_sessions SET metadata = jsonb_build_object('issueId', ${issueId}::text)
       WHERE kind = 'run_session' AND project_id = ${fx.projectId}
    `);
    const out = await read();
    expect(out.sessions[0]?.issues.map((i) => i.issueId)).toEqual([issueId]);
    expect(out.holds[0]?.holders).toHaveLength(1);
  });

  // ISS-1228 round 12: the route answered `report.since`, which the reference did not declare.
  it("answers exactly the shape its reference declares, a box's report and a returned lease included", async () => {
    await fx.seedIssue({ status: 'in_progress' });
    await fx.seedIssueLease(fx.lastSeq, 'running');
    await fx.db.execute(sql`
      INSERT INTO device_run_ledger (device_id, run_id, project_id, session_id, worktree_path, boot_id,
                                     incarnation, work, blocker_kind, waiting_on, issues, observed_at)
      SELECT s.device_id, 'run-shape', s.project_id, s.id, '/w', 'boot-1', 'live', 'blocked', 'human',
             'a decision', ${JSON.stringify([{ issueKey: `ISS-${fx.lastSeq}`, leaseReturned: true }])}::jsonb,
             now()
        FROM agent_sessions s WHERE s.project_id = ${fx.projectId} AND s.kind = 'run_session'
    `);
    const out = await read();
    expect(out.sessions[0]?.report?.since).toEqual(expect.any(String));
    expect(out.sessions[0]?.issues[0]?.boxReturned).toBe(true);
    const { sessionsAndHoldsSchema } = await import(
      '../../src/pipeline/sessions-and-holds-routes-reference.js'
    );
    const parsed = sessionsAndHoldsSchema.safeParse(JSON.parse(JSON.stringify(out)));
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });

  it('holds nothing for a lease whose session has ended', async () => {
    await fx.seedIssue({ status: 'in_progress' });
    await fx.seedIssueLease(fx.lastSeq, 'failed');
    const out = await read();
    expect(out.sessions).toEqual([]);
    expect(out.holds).toEqual([]);
  });
});

describe('readSessionsAndHolds — claims and parks (ISS-1228)', () => {
  it('holds an issue under a live claim and not one under an expired claim', async () => {
    const live = await fx.seedIssue({
      status: 'in_progress',
      sessionContext: { lease: testLease({ next: 'write the route' }) },
    });
    await fx.seedIssue({
      status: 'in_progress',
      sessionContext: {
        lease: testLease({ holder: 'other', renewedAt: '2026-09-20T14:00:00.000Z' }),
      },
    });
    const out = await read();
    expect(out.holds.map((h) => h.issueId)).toEqual([live]);
    expect(out.holds[0]?.holders[0]).toMatchObject({
      by: 'claim',
      renewedAt: '2026-09-20T15:45:00.000Z',
      next: 'write the route',
    });
  });

  it("holds a needs_info issue for a person, with the park record's reason", async () => {
    const id = await fx.seedIssue({ status: 'needs_info' });
    await moved(id, 'open', 'in_progress', null);
    await fx.db.execute(sql`
      INSERT INTO comments (id, issue_id, author_id, body, created_at)
      VALUES (${randomUUID()}, ${id}, ${fx.ownerId}, ${parkRecord}, now() - interval '4 minutes')
    `);
    await fx.db.execute(sql`
      INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, reason, actor_type,
                                      actor_id, source, created_at)
      VALUES ('issue', ${id}, 'in_progress', 'needs_info', 'parked', 'user', ${fx.ownerId}, 'issues',
              now() - interval '3 minutes')
    `);
    const [held] = (await read()).holds;
    expect(held?.holders).toEqual([
      expect.objectContaining({
        by: 'person',
        status: 'needs_info',
        why: 'which of the two readings ships',
      }),
    ]);
  });

  it('holds an on_hold issue with the reason its move gave', async () => {
    const id = await fx.seedIssue({ status: 'on_hold' });
    await moved(id, 'in_progress', 'on_hold', 'waiting on the vendor');
    const [held] = (await read()).holds;
    expect(held?.holders).toEqual([
      expect.objectContaining({
        by: 'person',
        status: 'on_hold',
        owes: null,
        why: 'waiting on the vendor',
      }),
    ]);
  });

  it('does not hold an issue that is merely in progress with nothing on it', async () => {
    await fx.seedIssue({ status: 'in_progress' });
    expect((await read()).holds).toEqual([]);
  });
});

describe('readSessionsAndHolds — archived issues (ISS-1228, ISS-1237)', () => {
  const archive = (id: string) =>
    fx.db.execute(sql`UPDATE issues SET archived_at = now() WHERE id = ${id}`);

  it('neither holds nor works an archived issue, whatever stands on it', async () => {
    const leased = await fx.seedIssue({ status: 'in_progress' });
    await fx.seedIssueLease(fx.lastSeq, 'running');
    const claimed = await fx.seedIssue({
      status: 'in_progress',
      sessionContext: { lease: testLease({ next: 'write the route' }) },
    });
    const parked = await fx.seedIssue({ status: 'on_hold' });
    await moved(parked, 'in_progress', 'on_hold', 'waiting on the vendor');
    for (const id of [leased, claimed, parked]) await archive(id);

    const out = await read();
    expect(out.holds).toEqual([]);
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]?.issues).toEqual([]);
  });
});
