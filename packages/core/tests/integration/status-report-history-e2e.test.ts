import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import copy from '../../src/status-reports/digest-copy.json' with { type: 'json' };
import { api, type Body, userToken } from '../helpers/api.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import {
  ago,
  DAY,
  issue,
  landHistory,
  MINUTE,
  type World,
  world,
} from '../helpers/forecast-world.js';
import { seedProductionDeployTrigger } from '../helpers/release-world.js';

// A project's status report is kept as dated history and sent on a schedule: a `status_report`
// schedule stores the status read for its period and tells each recipient once, in their language,
// linking to the stored report; the report says what changed since the one before, read from the two
// stored reports. Planted: last week's report, then one issue shipped and the next release's date
// moved — the diff names both, and sending the period twice tells each recipient once.

const LAG_MINUTES = 30;

/** A release run the Releases read lists: cut by the release batch, shipped at `at`. */
async function shipped(w: World, version: string, issueIds: readonly string[], at: Date) {
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, release_version, release_released_at, metadata)
    VALUES (gen_random_uuid(), ${w.projectId}, 'system', 'completed', ${at.toISOString()}, ${at.toISOString()},
            ${version}, ${at.toISOString()}, ${JSON.stringify({ issueIds, source: 'release-batch' })}::jsonb)
  `);
}

const shift = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

/** Every instant of a delivery forecast moved by `ms`: the same forecast, read on another day. */
function shiftedDelivery(d: Body, ms: number): Body {
  const out = structuredClone(d);
  const inHands = out.inHands as Body | null;
  if (inHands) {
    inHands.p50At = shift(inHands.p50At as string, ms);
    inHands.p85At = shift(inHands.p85At as string, ms);
  }
  const landing = out.landing as Body;
  if (landing.kind === 'forecast') {
    landing.p50At = shift(landing.p50At as string, ms);
    landing.p85At = shift(landing.p85At as string, ms);
  }
  return out;
}

describe('a status report kept as dated history and sent on a schedule', () => {
  let w: World;
  let member: { id: string; token: string };
  let outsider: string;
  let scheduleId = '';
  let lastWeek = '';
  let shippedIssue = { id: '', key: '' };
  let nextVersion = '';

  beforeAll(async () => {
    w = await world();
    await seedProductionDeployTrigger(w.projectId, w.userId, 'on-land');
    let v = 0;
    for (const h of await landHistory(w, 20)) {
      v += 1;
      await shipped(w, `0.0.${v}`, [h.id], new Date(h.mergedAt.getTime() + LAG_MINUTES * MINUTE));
    }
    await issue(w, { status: 'awaiting_release', createdAt: ago(3), mergedAt: ago(0.1) });
    shippedIssue = await issue(w, { status: 'closed', createdAt: ago(5), mergedAt: ago(1) });
    const m = await createTestUser({ verified: true });
    await addProjectMember(w.projectId, m.id, 'member');
    await db.execute(sql`INSERT INTO user_preferences (user_id, language) VALUES (${m.id}, 'vi')`);
    member = { id: m.id, token: await userToken(m.id) };
    outsider = (await createTestUser({ verified: true })).id;
  }, 120_000);

  const schedule = (params: Body) =>
    api(w.token, 'POST', '/api/schedules', {
      projectId: w.projectId,
      name: 'Weekly status',
      cron: '0 9 * * 1',
      kind: 'status_report',
      timeZone: 'Asia/Ho_Chi_Minh',
      params,
    });

  it('refuses a schedule with no recipients, by name', async () => {
    const res = await schedule({ recipients: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe('STATUS_REPORT_NO_RECIPIENTS');
  });

  it('refuses a recipient who is not a member of the project, naming them', async () => {
    const res = await schedule({ recipients: [w.userId, outsider] });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe('STATUS_REPORT_RECIPIENT_NOT_MEMBER');
    expect(String(res.body.detail)).toContain(outsider);
  });

  it('saves a weekly schedule naming its recipients among the members', async () => {
    const res = await schedule({ recipients: [w.userId, member.id] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    scheduleId = res.body.id as string;
    expect(res.body).toMatchObject({ kind: 'status_report', timeZone: 'Asia/Ho_Chi_Minh' });
    // Monday 09:00 in Ho Chi Minh City is 02:00 UTC
    const next = new Date(res.body.nextRunAt as string);
    expect([next.getUTCDay(), next.getUTCHours(), next.getUTCMinutes()]).toEqual([1, 2, 0]);
  });

  it('plants last week’s report: the read as it stood, before the issue shipped and with an earlier release date', async () => {
    const now = await api(w.token, 'GET', `/api/projects/${w.projectId}/status?days=7`);
    expect(now.status).toBe(200);
    const status = structuredClone(now.body);
    const next = status.nextRelease as Body;
    nextVersion = next.version as string;
    const delivery = (next.forecast as Body | null)?.delivery as Body | undefined;
    expect(delivery?.inHands ?? null, JSON.stringify(next)).not.toBeNull();
    (next.forecast as Body).delivery = shiftedDelivery(delivery as Body, -3 * DAY);
    lastWeek = shift(status.asOf as string, -7 * DAY);
    status.asOf = lastWeek;
    const period = new Date(Date.parse(lastWeek) - 60 * MINUTE);
    await db.execute(sql`
      INSERT INTO status_reports (id, project_id, producer_kind, produced_by, schedule_id, period, as_of, days, report)
      VALUES (${randomUUID()}, ${w.projectId}, 'schedule', ${w.userId}, ${scheduleId}, ${period.toISOString()},
              ${lastWeek}, 7, ${JSON.stringify(status)}::jsonb)
    `);
    await shipped(w, '0.0.90', [shippedIssue.id], ago(0.5));
  });

  it('sends the period once: each recipient is told once, and the second send is refused by name', async () => {
    const first = await api(w.token, 'POST', `/api/schedules/${scheduleId}/run`);
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    const second = await api(w.token, 'POST', `/api/schedules/${scheduleId}/run`);
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(second.body.code).toBe('STATUS_REPORT_PERIOD_DELIVERED');
    const told = await db.execute<{ user_id: string; n: number; title: string }>(sql`
      SELECT d.user_id, count(*)::int AS n, min(n.title) AS title
        FROM notifications n
        JOIN notification_delivery_members m ON m.notification_id = n.id
        JOIN notification_deliveries d ON d.id = m.delivery_id
       WHERE n.type = 'status_report' AND n.project_id = ${w.projectId}
       GROUP BY d.user_id
    `);
    const byUser = new Map([...told].map((r) => [r.user_id, r]));
    expect(byUser.get(w.userId)?.n).toBe(1);
    expect(byUser.get(member.id)?.n).toBe(1);
    expect(byUser.size).toBe(2);
    expect(byUser.get(member.id)?.title).toMatch(new RegExp(`^${copy.vi.title.split(' {')[0]} `));
    expect(byUser.get(w.userId)?.title).toMatch(/status report/);
    const fires = await db.execute<{
      status: string;
      reason: string | null;
      refusal: string | null;
    }>(sql`
      SELECT status, reason, refusal FROM schedule_runs WHERE schedule_id = ${scheduleId} ORDER BY created_at
    `);
    expect([...fires].map((f) => [f.status, f.reason, f.refusal])).toEqual([
      ['success', null, null],
      ['skipped', 'gate-refused', 'STATUS_REPORT_PERIOD_DELIVERED'],
    ]);
  });

  it('names the newly shipped issue and the moved release date since last week’s report', async () => {
    const list = await api(w.token, 'GET', `/api/projects/${w.projectId}/status/reports`);
    expect(list.status).toBe(200);
    const reports = list.body.reports as Body[];
    expect(reports).toHaveLength(2);
    expect((reports[1] as Body).asOf).toBe(new Date(lastWeek).toISOString());
    expect(reports[0]).toMatchObject({
      producer: { kind: 'schedule', schedule: { id: scheduleId, name: 'Weekly status' } },
    });
    const detail = await api(
      w.token,
      'GET',
      `/api/projects/${w.projectId}/status/reports/${(reports[0] as Body).id}`,
    );
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect((detail.body.previous as Body).id).toBe((reports[1] as Body).id);
    const diff = detail.body.diff as Body;
    const shippedLines = diff.shipped as Body[];
    expect(shippedLines.map((s) => s.version)).toEqual(['0.0.90']);
    expect(((shippedLines[0] as Body).issues as Body[]).map((i) => i.key)).toEqual([
      shippedIssue.key,
    ]);
    const moved = (diff.moved as Body[]).filter((m) => m.kind === 'release');
    expect(moved).toHaveLength(1);
    expect(String(moved[0]?.title)).toContain(nextVersion);
    const days = (Date.parse(moved[0]?.to as string) - Date.parse(moved[0]?.from as string)) / DAY;
    expect(days).toBeGreaterThan(2.9);
  });

  it('puts the report in each recipient’s inbox, linking to the stored report', async () => {
    const res = await api(member.token, 'GET', '/api/me/attention');
    expect(res.status).toBe(200);
    const items = res.body.statusReports as Body[];
    expect(items).toHaveLength(1);
    const link = String(items[0]?.link);
    expect(link).toMatch(/\/status\?tab=history&report=[0-9a-f-]{36}$/);
    const reportId = link.slice(-36);
    const read = await api(
      member.token,
      'POST',
      `/api/projects/${w.projectId}/status/reports/${reportId}/read`,
    );
    expect(read.body).toEqual({ read: 1 });
    const after = await api(member.token, 'GET', '/api/me/attention');
    expect(after.body.statusReports).toEqual([]);
  });

  it('keeps a report immutable: the store refuses any change by name', async () => {
    const refused = await db
      .execute(sql`UPDATE status_reports SET days = 30 WHERE project_id = ${w.projectId}`)
      .then(
        () => 'updated',
        (err: { cause?: { message?: string } }) => err.cause?.message ?? String(err),
      );
    expect(refused).toMatch(/^STATUS_REPORT_IMMUTABLE: /);
  });

  it('saves a report a person asks for, dated and naming them, with no period', async () => {
    const res = await api(w.token, 'POST', `/api/projects/${w.projectId}/status/reports`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      period: null,
      producer: { kind: 'person', user: { id: w.userId }, schedule: null },
    });
    const viewer = await api(
      member.token,
      'POST',
      `/api/projects/${w.projectId}/status/reports`,
      {},
    );
    expect(viewer.status, JSON.stringify(viewer.body)).toBe(201);
  });
});

describe('the zone a schedule is read in', () => {
  it('refuses a zone it cannot read the cron in', async () => {
    const z = await world();
    const res = await api(z.token, 'POST', '/api/schedules', {
      projectId: z.projectId,
      name: 'Weekly status',
      cron: '0 9 * * 1',
      kind: 'status_report',
      timeZone: 'Mars/Olympus',
      params: { recipients: [z.userId] },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Mars/Olympus');
  });
});
