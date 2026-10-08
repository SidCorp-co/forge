import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, type Body, userToken } from '../helpers/api.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import { type World, world } from '../helpers/forecast-world.js';

// A kept status report is removed by the person who saved it or by a project admin, and by nobody
// else: another member is refused by name, and a report a schedule sent to its recipients is an
// admin's to remove. Removing one takes its notices with it and leaves the rest of the history.

describe('removing a kept status report', () => {
  let w: World;
  let author: { id: string; token: string };
  let other: { id: string; token: string };
  let outsider: { id: string; token: string };

  const person = async (role?: 'member') => {
    const u = await createTestUser({ verified: true });
    if (role) await addProjectMember(w.projectId, u.id, role);
    return { id: u.id, token: await userToken(u.id) };
  };
  const reports = (token: string) =>
    api(token, 'GET', `/api/projects/${w.projectId}/status/reports`);
  const save = async (token: string) => {
    const res = await api(token, 'POST', `/api/projects/${w.projectId}/status/reports`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };
  const remove = (token: string, reportId: string) =>
    api(token, 'DELETE', `/api/projects/${w.projectId}/status/reports/${reportId}`);
  const ids = async () => ((await reports(w.token)).body.reports as Body[]).map((r) => r.id);

  beforeAll(async () => {
    w = await world();
    author = await person('member');
    other = await person('member');
    outsider = await person();
  }, 120_000);

  it('lets the person who saved a report remove it, and keeps the others', async () => {
    const kept = await save(w.token);
    const mine = await save(author.token);
    const res = await remove(author.token, mine);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ deleted: mine });
    expect(await ids()).toEqual([kept]);
  });

  it('lets a project admin remove a report someone else saved', async () => {
    const theirs = await save(author.token);
    const res = await remove(w.token, theirs);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await ids()).not.toContain(theirs);
  });

  it('refuses another member by name, and the report stays', async () => {
    const theirs = await save(author.token);
    const res = await remove(other.token, theirs);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('STATUS_REPORT_DELETE_FORBIDDEN');
    expect(String(res.body.detail)).toContain('saved it');
    expect(await ids()).toContain(theirs);
  });

  it('refuses a person outside the project, and the report stays', async () => {
    const theirs = await save(author.token);
    const res = await remove(outsider.token, theirs);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await ids()).toContain(theirs);
  });

  it('answers 404 for a report that is not this project’s', async () => {
    const res = await remove(w.token, randomUUID());
    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });

  it('keeps a sent report for an admin to remove, taking its notices with it', async () => {
    const scheduled = await api(w.token, 'POST', '/api/schedules', {
      projectId: w.projectId,
      name: 'Weekly status',
      cron: '0 9 * * 1',
      kind: 'status_report',
      timeZone: 'Asia/Ho_Chi_Minh',
      params: { recipients: [w.userId, author.id] },
    });
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(201);
    const run = await api(w.token, 'POST', `/api/schedules/${scheduled.body.id}/run`);
    expect(run.status, JSON.stringify(run.body)).toBe(202);
    const [sent] = await db.execute<{ id: string }>(sql`
      SELECT id FROM status_reports WHERE schedule_id = ${scheduled.body.id as string}
    `);
    const sentId = sent?.id as string;
    // the schedule reads the report as its owner, so the owner is its producer, never a member
    // it was sent to
    const byRecipient = await remove(author.token, sentId);
    expect(byRecipient.status, JSON.stringify(byRecipient.body)).toBe(403);
    expect(byRecipient.body.code).toBe('STATUS_REPORT_DELETE_FORBIDDEN');
    const byAdmin = await remove(w.token, sentId);
    expect(byAdmin.status, JSON.stringify(byAdmin.body)).toBe(200);
    const [left] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM notifications WHERE status_report_id = ${sentId}
    `);
    expect(left?.n).toBe(0);
  });
});
