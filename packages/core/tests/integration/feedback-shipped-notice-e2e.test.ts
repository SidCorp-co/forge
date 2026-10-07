/**
 * A shipped release tells the people whose feedback it closed: the stamp that records the ship puts
 * `release.shipped` on the outbox once, the notify-feedback consumer writes the reporter a notice naming
 * the item, the release and the user-facing note, and the item's page reads "told" back off that notice.
 * An item still owed another carrier is not told; a reporter with no bell is named, not skipped.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, type Body } from '../helpers/api.js';
import { ago, feedback, issue, type World, world } from '../helpers/forecast-world.js';

let w: World;

async function releaseRun(version: string, issueIds: string[]): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, metadata)
    VALUES (${id}, ${w.projectId}, 'system', 'running', now(), ${version}, ${JSON.stringify({ issueIds })}::jsonb)
  `);
  return id;
}

const closed = (over: { title?: string } = {}) =>
  issue(w, { status: 'closed', createdAt: ago(30), mergedAt: ago(2), ...over });

async function note(issueId: string, userFacing: string): Promise<void> {
  await db.execute(sql`
    UPDATE issues SET release_notes = ${JSON.stringify({ section: 'Fixed', userFacing })}::jsonb WHERE id = ${issueId}
  `);
}

async function detail(key: string): Promise<Body> {
  const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/feedback/${key}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.feedback as Body;
}

const notices = async (type: string) =>
  (await db.execute(sql`
    SELECT n.title, n.body, n.dedupe_key,
           (SELECT count(*)::int FROM notification_delivery_members m WHERE m.notification_id = n.id) AS delivered
      FROM notifications n WHERE n.project_id = ${w.projectId} AND n.type = ${type} ORDER BY n.created_at
  `)) as unknown as { title: string; body: string; dedupe_key: string; delivered: number }[];

async function ship(runId: string, version: string, issueIds: string[]) {
  const { stampReleaseShipped } = await import('../../src/pipeline/index.js');
  await stampReleaseShipped(runId);
  const { consumerOf } = await import('../../src/outbox/consumers.js');
  await consumerOf('release.shipped', 'notify-feedback')?.handle(
    { projectId: w.projectId, runId, version, issueIds },
    { eventId: randomUUID() } as never,
  );
}

beforeAll(async () => {
  const { registerFeedbackNotifications } = await import(
    '../../src/notifications/notify-feedback.js'
  );
  registerFeedbackNotifications();
  w = await world();
}, 120_000);

describe('the release that ships an item tells its reporter', () => {
  it('stamps the ship onto the outbox once, then writes the reporter one notice and the page reads it', async () => {
    const carrier = await closed();
    await note(carrier.id, 'Saving the board keeps every card.');
    const fb = await feedback(w, [carrier.id]);
    const before = await detail(fb);
    expect(before.shipNotice).toMatchObject({
      state: 'not_told',
      reason: 'No release carries it, so none told the reporter: tell them yourself.',
      shipped: { release: null },
      beforeNotices: false,
    });
    expect(
      ((before.shipNotice as Body).shipped as Body).at,
      'the page must say WHEN it shipped, off the carrier',
    ).toBeTruthy();

    const runId = await releaseRun('0.1.0', [carrier.id]);
    await ship(runId, '0.1.0', [carrier.id]);
    const { stampReleaseShipped } = await import('../../src/pipeline/index.js');
    await stampReleaseShipped(runId);

    const outbox = (await db.execute(sql`
      SELECT payload FROM pipeline_outbox WHERE type = 'release.shipped' AND payload ->> 'runId' = ${runId}
    `)) as unknown as { payload: Body }[];
    expect(outbox, 'a retried stamp must not tell the outbox twice').toHaveLength(1);
    expect(outbox[0]?.payload).toMatchObject({ version: '0.1.0', issueIds: [carrier.id] });

    const sent = await notices('feedback_shipped');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.title).toContain(fb);
    expect(sent[0]?.title).toContain('0.1.0');
    expect(sent[0]?.body).toBe('Saving the board keeps every card.');
    expect(sent[0]?.delivered).toBe(1);

    const after = await detail(fb);
    expect(after.shipNotice).toMatchObject({ state: 'told', release: '0.1.0' });
  });

  it('does not tell a reporter whose item is still owed another carrier', async () => {
    const done = await closed();
    const open = await issue(w, { status: 'in_progress', createdAt: ago(5) });
    const fb = await feedback(w, [done.id, open.id]);
    const runId = await releaseRun('0.1.1', [done.id]);
    await ship(runId, '0.1.1', [done.id]);
    expect((await notices('feedback_shipped')).filter((n) => n.title.includes(fb))).toEqual([]);
    expect((await detail(fb)).shipNotice).toBeNull();
  });

  it('names a reporter that is an agent instead of skipping the item', async () => {
    const carrier = await closed();
    const fb = await feedback(w, [carrier.id]);
    await db.execute(sql`
      UPDATE feedback SET reporter_agency = 'agent' WHERE project_id = ${w.projectId} AND fb_seq = ${Number(fb.slice(3))}
    `);
    const runId = await releaseRun('0.1.2', [carrier.id]);
    await ship(runId, '0.1.2', [carrier.id]);
    expect((await notices('feedback_shipped')).filter((n) => n.title.includes(fb))).toEqual([]);
    expect((await detail(fb)).shipNotice).toMatchObject({ state: 'not_told' });
    expect(String(((await detail(fb)).shipNotice as Body).reason)).toContain('agent');
  });
});

describe('an item that shipped before Forge told reporters says so, never "no release has told"', () => {
  async function noticesBegan(): Promise<void> {
    await db.execute(sql`
      INSERT INTO pipeline_outbox (type, project_id, payload)
      VALUES ('release.shipped', ${w.projectId}, ${JSON.stringify({ projectId: w.projectId, runId: randomUUID(), version: '9.9.9', issueIds: [] })}::jsonb)
    `);
  }

  it('names the release and the date when the carrier was cut into a release the emitter never saw', async () => {
    const carrier = await closed();
    const runId = randomUUID();
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, release_released_at, metadata)
      VALUES (${runId}, ${w.projectId}, 'system', 'completed', ${ago(60).toISOString()}::timestamptz, '0.0.9', ${ago(50).toISOString()}::timestamptz, '{}'::jsonb)
    `);
    await db.execute(
      sql`UPDATE issues SET release_batch_run_id = ${runId} WHERE id = ${carrier.id}`,
    );
    const fb = await feedback(w, [carrier.id]);
    await noticesBegan();
    const d = await detail(fb);
    expect(d.shipNotice).toMatchObject({
      state: 'not_told',
      reason: 'It shipped before Forge told reporters when a release shipped.',
      shipped: { release: '0.0.9' },
      beforeNotices: true,
    });
    expect((d.waitingOn as Body).act, 'the reporter verifies THAT release').toBe(
      'verify the fix shipped in 0.0.9',
    );
    expect((d.waitingOn as Body).ref).toBe('0.0.9');
  });

  it('names a release that shipped after notices began and sent none, without the "before" claim', async () => {
    await noticesBegan();
    const carrier = await closed();
    const runId = randomUUID();
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, release_released_at, metadata)
      VALUES (${runId}, ${w.projectId}, 'system', 'completed', now(), '0.0.10', now(), '{}'::jsonb)
    `);
    await db.execute(
      sql`UPDATE issues SET release_batch_run_id = ${runId} WHERE id = ${carrier.id}`,
    );
    const fb = await feedback(w, [carrier.id]);
    expect((await detail(fb)).shipNotice).toMatchObject({
      state: 'not_told',
      reason: '0.0.10 shipped it and sent the reporter no notice.',
      beforeNotices: false,
    });
  });
});

describe('the release page lists the feedback it answers', () => {
  async function releaseDetail(version: string): Promise<Body> {
    const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/releases/${version}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.release as Body;
  }

  it('names each item the release issues carry, with its reporter and whether the release told them', async () => {
    const carrier = await closed();
    const fb = await feedback(w, [carrier.id]);
    const other = await closed();
    const bystander = await feedback(w, [other.id]);
    const runId = await releaseRun('0.2.0', [carrier.id]);
    await db.execute(
      sql`UPDATE issues SET release_batch_run_id = ${runId} WHERE id = ${carrier.id}`,
    );
    await db.execute(
      sql`UPDATE pipeline_runs SET metadata = metadata || '{"source":"release-batch"}'::jsonb WHERE id = ${runId}`,
    );
    expect(
      ((await releaseDetail('0.2.0')).feedbackAnswered as Body[]).map((f) => [f.key, f.told]),
    ).toEqual([[fb, 'on_ship']]);

    await ship(runId, '0.2.0', [carrier.id]);
    const answered = (await releaseDetail('0.2.0')).feedbackAnswered as Body[];
    expect(answered.map((f) => f.key)).not.toContain(bystander);
    expect(answered).toEqual([
      expect.objectContaining({
        key: fb,
        title: expect.stringContaining('feedback'),
        told: 'told',
        agency: 'human',
      }),
    ]);
    expect(answered[0]?.toldAt).toBeTruthy();
    expect(typeof answered[0]?.reporter).toBe('string');
  });
});
