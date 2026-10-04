// cm:why ISS-114 (design automation rev 1, steps streak, settle and needs_you; REQ-16 BC-2, BC-5,
// BC-6): the automation read model counts what a fire produced by join, reads the failing streak by
// alert A5's own rule, and addresses needs-you so the menu count equals the list it opens, driven
// through the mounted app, the ticker and real Postgres.
// @gate-input whole-tree

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestProjectMember, createTestUser } from '../helpers/index.js';
import {
  adminBearer,
  call,
  createSchedule,
  firesOf,
  g,
  tick,
  useFireGround,
} from './schedule-fire-ground.js';

useFireGround();

type Row = { id: string };
type Wait = { kind: string; act: string | null };
type Standing = {
  failStreak: number;
  schedules: Array<{
    id: string;
    state: string;
    streak: number;
    attentionGroup: string;
    waitingOn: Wait;
    owner: { id: string } | null;
  }>;
  fires: Array<{
    id: string;
    status: string;
    attentionGroup: string;
    produced: Record<string, number>;
    waitingOn: Wait;
  }>;
  reports: Array<{
    id: string;
    attentionGroup: string;
    waitingOn: Wait;
    fire: { id: string } | null;
  }>;
  proposals: Array<{ fireId: string; kind: string; skill: string }>;
};
type NeedsYou = {
  areas: { automation: { you: number; acts: Array<{ act: string; count: number }> } };
};

async function one<T extends Row>(q: ReturnType<typeof sql>): Promise<T> {
  const rows = (await g.harness.db.execute(q)) as unknown as T[];
  const row = rows[0];
  if (!row) throw new Error('insert returned no row');
  return row;
}

async function person(role: 'admin' | 'member' | 'viewer'): Promise<string> {
  const id = (await createTestUser(g.harness.db, { emailVerifiedAt: new Date() })).id;
  await createTestProjectMember(g.harness.db, { userId: id, projectId: g.projectId, role });
  return id;
}

const bearerOf = (userId: string) => g.m.jwt.signUserToken(userId);

async function standingAs(userId: string): Promise<Standing> {
  const res = await call(
    'GET',
    `/api/projects/${g.projectId}/automation/standing`,
    await bearerOf(userId),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Standing;
}

async function needsYouAs(userId: string): Promise<NeedsYou> {
  const res = await call('GET', `/api/projects/${g.projectId}/needs-you`, await bearerOf(userId));
  expect(res.status).toBe(200);
  return (await res.json()) as NeedsYou;
}

async function scheduleOwnedBy(ownerId: string | null, name = 'owned'): Promise<string> {
  const row = await one<Row>(sql`
    INSERT INTO schedules (project_id, name, cron, prompt, kind, owner_id, next_run_at)
    VALUES (${g.projectId}, ${name}, '0 3 * * *', 'go', 'prompt', ${ownerId}, now() + interval '1 day')
    RETURNING id`);
  return row.id;
}

async function fireOf(
  scheduleId: string,
  status: 'success' | 'failed' | 'skipped',
  opts: { reason?: string; minutesAgo?: number; sessionId?: string | null } = {},
): Promise<string> {
  const at = new Date(Date.now() - (opts.minutesAgo ?? 10) * 60_000).toISOString();
  const row = await one<Row>(sql`
    INSERT INTO schedule_runs (schedule_id, project_id, trigger, status, reason, session_id, started_at, finished_at, created_at)
    VALUES (${scheduleId}, ${g.projectId}, 'scheduled', ${status}, ${opts.reason ?? null},
            ${opts.sessionId ?? null}, ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz)
    RETURNING id`);
  return row.id;
}

async function reportFrom(fireId: string | null, summary = 'a report'): Promise<string> {
  const row = await one<Row>(sql`
    INSERT INTO agent_reports (project_id, kind, severity, target, summary, signal_key, schedule_run_id)
    VALUES (${g.projectId}, 'friction', 'high', 'tool', ${summary}, 'self_report:tool:x:friction', ${fireId})
    RETURNING id`);
  return row.id;
}

describe('Fire.produced counts what a fire made by join, never by a stored total', () => {
  it('a fixture fire with one report, proposal, issue and notification reads 1/1/1/1', async () => {
    const scheduleId = await scheduleOwnedBy(g.adminId, 'steward');
    const run = await one<Row>(sql`
      INSERT INTO pipeline_runs (project_id, kind, status, metadata)
      VALUES (${g.projectId}, 'system', 'completed', '{}'::jsonb) RETURNING id`);
    const report = {
      actions: [
        { skill: 'forge-test', kind: 'proposed', summary: 'add a planted-red recipe' },
        { skill: 'forge-code', kind: 'feedback', summary: 'not a proposal' },
      ],
    };
    const session = await one<Row>(sql`
      INSERT INTO agent_sessions (project_id, user_id, kind, status, metadata, pipeline_run_id)
      VALUES (${g.projectId}, ${g.adminId}, 'chat', 'completed',
              ${JSON.stringify({ stewardReport: report })}::jsonb, ${run.id}) RETURNING id`);
    const fireId = await fireOf(scheduleId, 'success', { sessionId: session.id });
    await reportFrom(fireId);
    await g.harness.db.execute(sql`
      INSERT INTO issues (project_id, title, status, created_by_id, schedule_run_id)
      VALUES (${g.projectId}, 'filed by the fire', 'draft', ${g.adminId}, ${fireId})`);
    await g.harness.db.execute(sql`
      INSERT INTO notifications (project_id, type, kind, tier, state, title, schedule_run_id)
      VALUES (${g.projectId}, 'schedule_report', 'signal', 'log', 'emitted', 'batch cut', ${fireId})`);

    const standing = await standingAs(g.adminId);
    const fire = standing.fires.find((f) => f.id === fireId);
    expect(fire?.produced).toEqual({
      reports: 1,
      newReports: 1,
      proposals: 1,
      issues: 1,
      runs: 0,
      notifications: 1,
    });
    expect(standing.proposals).toEqual([
      expect.objectContaining({ fireId, kind: 'proposed', skill: 'forge-test' }),
    ]);

    const res = await call(
      'GET',
      `/api/projects/${g.projectId}/automation/fires/${fireId}`,
      await adminBearer(),
    );
    expect(res.status).toBe(200);
    const detail = (await res.json()) as { produced: Record<string, unknown[]> };
    expect(
      Object.fromEntries(Object.entries(detail.produced).map(([k, v]) => [k, v.length])),
    ).toEqual({
      reports: 1,
      proposals: 1,
      issues: 1,
      runs: 0,
      notifications: 1,
    });
  });

  it('an issue a scheduled session files through MCP names that session’s fire', async () => {
    const scheduleId = await createSchedule({ prompt: 'file what you find' });
    await tick(scheduleId);
    const [fire] = await firesOf(scheduleId);
    expect(fire?.sessionId).not.toBeNull();
    const start = [...(g.sockets[0]?.frames ?? [])]
      .reverse()
      .find((f) => f.event === 'agent:start');
    const credential = (start?.data as { forgeToken?: string } | undefined)?.forgeToken;
    expect(credential, 'the fire handed its session a credential').toBeTruthy();
    const res = await g.app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'forge_issues',
          arguments: {
            action: 'create',
            projectId: g.projectId,
            data: { title: 'found by the fire', status: 'draft' },
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const [issue] = (await g.harness.db.execute(
      sql`SELECT schedule_run_id FROM issues WHERE title = 'found by the fire'`,
    )) as unknown as Array<{ schedule_run_id: string | null }>;
    expect(issue?.schedule_run_id).toBe(fire?.id);

    const person = await call('POST', `/api/projects/${g.projectId}/issues`, await adminBearer(), {
      title: 'filed by a person',
    });
    expect(person.status).toBe(201);
    const [own] = (await g.harness.db.execute(
      sql`SELECT schedule_run_id FROM issues WHERE title = 'filed by a person'`,
    )) as unknown as Array<{ schedule_run_id: string | null }>;
    expect(own?.schedule_run_id).toBeNull();
  });
});

describe('a schedule is failing by alert A5’s own rule, served to every member', () => {
  async function a5Schedules(): Promise<string[]> {
    const { computeAlerts } = await import('../../src/admin/alert-queries.js');
    const { ADMIN_THRESHOLD_DEFAULTS } = await import('../../src/admin/types.js');
    const alerts = await computeAlerts({
      thresholds: { ...ADMIN_THRESHOLD_DEFAULTS, scheduleFailStreak: 2 },
    });
    return (alerts.find((a) => a.key === 'automation_failing')?.entities ?? []).map((e) => e.ref);
  }

  it('a failure and a no-device skip are failing for a viewer and in A5; already-applied is not', async () => {
    const failing = await scheduleOwnedBy(g.adminId, 'failing');
    await fireOf(failing, 'failed', { minutesAgo: 20 });
    await fireOf(failing, 'skipped', { reason: 'no-device', minutesAgo: 10 });
    const quiet = await scheduleOwnedBy(g.adminId, 'quiet');
    await fireOf(quiet, 'failed', { minutesAgo: 30 });
    await fireOf(quiet, 'skipped', { reason: 'already-applied', minutesAgo: 20 });
    await fireOf(quiet, 'skipped', { reason: 'already-applied', minutesAgo: 10 });
    const cleared = await scheduleOwnedBy(g.adminId, 'cleared');
    await fireOf(cleared, 'failed', { minutesAgo: 30 });
    await fireOf(cleared, 'failed', { minutesAgo: 20 });
    await fireOf(cleared, 'success', { minutesAgo: 10 });

    const viewer = await person('viewer');
    const standing = await standingAs(viewer);
    const state = (id: string) => standing.schedules.find((s) => s.id === id);
    expect(standing.failStreak).toBe(2);
    expect(state(failing)).toMatchObject({ state: 'failing', streak: 2 });
    expect(state(quiet)).toMatchObject({ state: 'on', streak: 1 });
    expect(state(cleared)).toMatchObject({ state: 'on', streak: 0 });

    const alerted = await a5Schedules();
    expect(alerted).toContain(failing);
    expect(alerted).not.toContain(quiet);
    expect(alerted).not.toContain(cleared);
  });
});

describe('needs-you counts automation from the list it opens, per viewer', () => {
  it('an owner, a member and an admin each read the count their own list groups under Needs you', async () => {
    const owner = await person('member');
    const member = await person('member');
    const admin = g.adminId;

    const owned = await scheduleOwnedBy(owner, 'owned');
    const ownedFire = await fireOf(owned, 'failed', { minutesAgo: 20 });
    await fireOf(owned, 'failed', { minutesAgo: 10 });
    const fromFire = await reportFrom(ownedFire, 'filed by the owner’s fire');
    const loose = await reportFrom(null, 'filed by an issue run');
    const ownerless = await scheduleOwnedBy(null, 'ownerless');

    const expected: Record<string, { you: number; acts: Record<string, number> }> = {
      [owner]: { you: 3, acts: { fix_schedule: 1, triage_report: 2 } },
      [member]: { you: 1, acts: { triage_report: 1 } },
      [admin]: { you: 2, acts: { reassign_owner: 1, triage_report: 1 } },
    };
    for (const [viewer, want] of Object.entries(expected)) {
      const standing = await standingAs(viewer);
      const listed = [...standing.schedules, ...standing.reports].filter(
        (r) => r.attentionGroup === 'needs_you',
      );
      const area = (await needsYouAs(viewer)).areas.automation;
      expect(area.you, `needs-you count for ${viewer}`).toBe(listed.length);
      expect(area.you).toBe(want.you);
      expect(Object.fromEntries(area.acts.map((a) => [a.act, a.count]))).toEqual(want.acts);
    }

    const forMember = await standingAs(member);
    expect(forMember.reports.find((r) => r.id === fromFire)).toMatchObject({
      attentionGroup: 'waiting',
      waitingOn: { kind: 'person', act: 'triage_report' },
      fire: { id: ownedFire },
    });
    expect(forMember.reports.find((r) => r.id === loose)?.attentionGroup).toBe('needs_you');
    expect(forMember.schedules.find((s) => s.id === ownerless)).toMatchObject({
      state: 'owner_gone',
      waitingOn: { kind: 'admins', act: 'reassign_owner' },
    });
  });

  it('a non-member is refused the read, and a schedule of another project is a 404', async () => {
    const stranger = (await createTestUser(g.harness.db, { emailVerifiedAt: new Date() })).id;
    const res = await call(
      'GET',
      `/api/projects/${g.projectId}/automation/standing`,
      await bearerOf(stranger),
    );
    expect(res.status).toBe(403);
    const missing = await call(
      'GET',
      `/api/projects/${g.projectId}/automation/schedules/00000000-0000-4000-8000-000000000114`,
      await adminBearer(),
    );
    expect(missing.status).toBe(404);
  });
});
