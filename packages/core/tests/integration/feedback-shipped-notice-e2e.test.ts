/**
 * A shipped release tells the people whose feedback it closed: the stamp that records the ship puts
 * `release.shipped` on the outbox once, the notify-feedback consumer writes the reporter a notice naming
 * the item, the release and the user-facing note, and the item's page reads "told" back off that notice.
 * An item still owed another carrier is not told; a reporter with no bell is named, not skipped.
 */

import { randomUUID } from 'node:crypto';
import { saidDisagreements } from '@forge/contracts/said';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, type Body } from '../helpers/api.js';
import { createTestUser } from '../helpers/factories.js';
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

const closed = (over: { title?: string; mergedAt?: Date } = {}) =>
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
    const carrier = await closed({ mergedAt: new Date() });
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

describe("a project's first release notice is the cutoff: before it nothing was owed, after it a relay is", () => {
  let v: World;
  let reporter = '';
  const at = (path: string) => `/api/projects/${v.projectId}${path}`;
  const read = async (path: string): Promise<Body> => {
    const res = await api(v.token, 'GET', at(path));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };

  /** A carrier shipped in `version` at `releasedAt`, carrying one item reported by someone else. */
  async function shippedItem(version: string, releasedAt: Date): Promise<string> {
    const carrier = await issue(v, { status: 'closed', createdAt: ago(80), mergedAt: releasedAt });
    const runId = randomUUID();
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, release_released_at, metadata)
      VALUES (${runId}, ${v.projectId}, 'system', 'completed', ${releasedAt.toISOString()}::timestamptz, ${version},
              ${releasedAt.toISOString()}::timestamptz, ${JSON.stringify({ issueIds: [carrier.id], source: 'release-batch' })}::jsonb)
    `);
    await db.execute(
      sql`UPDATE issues SET release_batch_run_id = ${runId} WHERE id = ${carrier.id}`,
    );
    const fb = await feedback(v, [carrier.id]);
    await db.execute(sql`
      UPDATE feedback SET reported_by = ${reporter} WHERE project_id = ${v.projectId} AND fb_seq = ${Number(fb.slice(3))}
    `);
    return fb;
  }

  let before = '';
  let after = '';
  const cutoff = ago(24);

  beforeAll(async () => {
    v = await world();
    reporter = (await createTestUser({ verified: true })).id;
    before = await shippedItem('0.0.9', ago(50));
    after = await shippedItem('0.0.10', ago(1));
    // the first release.shipped of THIS project; another project's earlier notices do not count
    await db.execute(sql`
      INSERT INTO pipeline_outbox (type, project_id, payload, created_at)
      VALUES ('release.shipped', ${v.projectId}, ${JSON.stringify({ projectId: v.projectId, runId: randomUUID(), version: '9.9.9', issueIds: [] })}::jsonb,
              ${cutoff.toISOString()}::timestamptz)
    `);
  });

  it("names an item shipped before the cutoff, dated, and puts it on nobody's Needs you", async () => {
    const d = (await read(`/feedback/${before}`)).feedback as Body;
    expect(d.shipNotice).toMatchObject({
      state: 'not_told',
      reason: `Shipped before release notices existed on this project (${cutoff.toISOString().slice(0, 10)}).`,
      shipped: { release: '0.0.9' },
      beforeNotices: true,
    });
    expect(Date.parse(String((d.shipNotice as Body).noticesBegan))).toBe(cutoff.getTime());
    expect(d.reporterNotTold).toBe('before_notices');
    expect(d.attentionGroup, "no stale relay on anyone's Needs you").not.toBe('needs_you');
    expect((d.waitingOn as Body).act).toBe('verify the fix shipped in 0.0.9');
    expect((d.can as Body).tellShipped, 'anyone who wants to may still tell them').toBe(true);
    expect((d.shipNotice as Body).says).toEqual({
      reason: { key: 'feedback.notice.before', vars: { date: cutoff.toISOString().slice(0, 10) } },
    });
    expect(saidDisagreements(d), 'what it says and its English agree').toEqual([]);
  });

  it("keeps an item shipped after the cutoff and never told on the triager's Needs you", async () => {
    const d = (await read(`/feedback/${after}`)).feedback as Body;
    expect(d.shipNotice).toMatchObject({
      state: 'not_told',
      reason: '0.0.10 shipped it and sent the reporter no notice.',
      beforeNotices: false,
    });
    expect(d.reporterNotTold).toBe('owed');
    expect(d.attentionGroup).toBe('needs_you');
    expect(String((d.waitingOn as Body).act)).toMatch(/^tell .+ that it shipped in 0\.0\.10$/);
    expect(((d.waitingOn as Body).says as Body).act).toMatchObject({
      key: 'standing.act.tellShippedIn',
      vars: { v: '0.0.10' },
    });
    expect(saidDisagreements(d)).toEqual([]);
  });

  it('counts the two apart on the feedback list and on the release page', async () => {
    const list = await read('/feedback');
    expect(list.untold).toMatchObject({ owed: 1, beforeNotices: 1 });
    expect(Date.parse(String((list.untold as Body).noticesBegan))).toBe(cutoff.getTime());
    const old = (await read('/releases/0.0.9')).release as Body;
    expect((old.feedbackAnswered as Body[]).map((f) => [f.key, f.told])).toEqual([
      [before, 'before_notices'],
    ]);
    expect(old.feedbackToldCounts).toMatchObject({ before_notices: 1, not_told: 0 });
    const recent = (await read('/releases/0.0.10')).release as Body;
    expect(recent.feedbackToldCounts).toMatchObject({ before_notices: 0, not_told: 1 });
  });

  it('tells the reporter now, in their language, once; then the item reads told', async () => {
    await db.execute(
      sql`INSERT INTO user_preferences (user_id, language) VALUES (${reporter}, 'vi')`,
    );
    await note(
      (
        (await db.execute(sql`
          SELECT ri.issue_id AS id FROM feedback_route_issues ri JOIN feedback f ON f.id = ri.feedback_id
           WHERE f.project_id = ${v.projectId} AND f.fb_seq = ${Number(before.slice(3))}
        `)) as unknown as { id: string }[]
      )[0]?.id as string,
      'Bảng giữ bộ lọc sau khi tải lại.',
    );
    const res = await api(v.token, 'POST', at(`/feedback/${before}/tell-shipped`), {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = res.body.feedback as Body;
    expect(d.shipNotice).toMatchObject({ state: 'told', how: 'message', release: '0.0.9' });
    expect(d.reporterNotTold).toBeNull();
    const [event] = (await db.execute(sql`
      SELECT payload FROM pipeline_outbox
       WHERE type = 'feedback.reporterTold' AND payload ->> 'projectId' = ${v.projectId}
    `)) as unknown as { payload: Body }[];
    expect(event?.payload).toMatchObject({
      recipients: [reporter],
      title: `${before} đã được phát hành trong bản 0.0.9: feedback ${Number(before.slice(3))}`,
      body: 'Bảng giữ bộ lọc sau khi tải lại.',
    });
    const again = await api(v.token, 'POST', at(`/feedback/${before}/tell-shipped`), {});
    expect(again.status).toBe(422);
    expect(JSON.stringify(again.body)).toContain('FEEDBACK_ALREADY_TOLD');
  });

  it('refuses telling now an item that has not shipped, by name', async () => {
    const open = await issue(v, { status: 'in_progress', createdAt: ago(5) });
    const fb = await feedback(v, [open.id]);
    const res = await api(v.token, 'POST', at(`/feedback/${fb}/tell-shipped`), {});
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('FEEDBACK_NOT_RESOLVED');
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

describe("the notice is the reporter's, in their words, once", () => {
  it('is written in the language the reporter reads, with the release note as what changed', async () => {
    await db.execute(sql`
      INSERT INTO user_preferences (user_id, language) VALUES (${w.userId}, 'vi')
      ON CONFLICT (user_id) DO UPDATE SET language = 'vi'
    `);
    try {
      const carrier = await closed();
      await note(carrier.id, 'Lưu bảng giữ nguyên mọi thẻ.');
      const fb = await feedback(w, [carrier.id]);
      const runId = await releaseRun('0.3.0', [carrier.id]);
      await ship(runId, '0.3.0', [carrier.id]);
      const [sent] = (await notices('feedback_shipped')).filter((n) => n.title.includes(fb));
      expect(sent?.title, 'a reporter who reads Vietnamese is told in Vietnamese').toContain(
        `${fb} đã được phát hành trong bản 0.3.0`,
      );
      expect(sent?.body).toBe('Lưu bảng giữ nguyên mọi thẻ.');
    } finally {
      await db.execute(sql`DELETE FROM user_preferences WHERE user_id = ${w.userId}`);
    }
  });

  it("never puts an issue title in the reporter's prose when the release note says nothing", async () => {
    const carrier = await closed({ title: 'fix(core): ISS-12 drop the stale cache row' });
    const fb = await feedback(w, [carrier.id]);
    const runId = await releaseRun('0.3.1', [carrier.id]);
    await ship(runId, '0.3.1', [carrier.id]);
    const [sent] = (await notices('feedback_shipped')).filter((n) => n.title.includes(fb));
    expect(sent?.body).toBe('0.3.1 carries the work your feedback asked for.');
    expect(sent?.body).not.toContain('ISS-');
  });

  it('tells the reporter once when a second release carries the same item again', async () => {
    const carrier = await closed();
    const fb = await feedback(w, [carrier.id]);
    const first = await releaseRun('0.3.2', [carrier.id]);
    await ship(first, '0.3.2', [carrier.id]);
    await ship(first, '0.3.2', [carrier.id]);
    const again = await releaseRun('0.3.3', [carrier.id]);
    await ship(again, '0.3.3', [carrier.id]);
    const sent = (await notices('feedback_shipped')).filter((n) => n.title.includes(fb));
    expect(sent, 'a re-run or a second release tells nobody twice').toHaveLength(1);
    expect((await detail(fb)).shipNotice).toMatchObject({
      state: 'told',
      how: 'notice',
      release: '0.3.2',
    });
  });
});

describe('a reporter no bell reaches is relayed to by a person, on their Needs you until done', () => {
  async function agentItem(version: string): Promise<{ fb: string; runId: string }> {
    const reporter = await createTestUser({ kind: 'agent' });
    const carrier = await closed();
    const fb = await feedback(w, [carrier.id]);
    await db.execute(sql`
      UPDATE feedback SET reporter_agency = 'agent', reported_by = ${reporter.id}
       WHERE project_id = ${w.projectId} AND fb_seq = ${Number(fb.slice(3))}
    `);
    const runId = await releaseRun(version, [carrier.id]);
    await db.execute(
      sql`UPDATE issues SET release_batch_run_id = ${runId} WHERE id = ${carrier.id}`,
    );
    await db.execute(sql`
      UPDATE pipeline_runs SET release_released_at = now(),
             metadata = metadata || '{"source":"release-batch"}'::jsonb WHERE id = ${runId}
    `);
    await ship(runId, version, [carrier.id]);
    return { fb, runId };
  }

  const send = (fb: string, body: Body) =>
    api(w.token, 'POST', `/api/projects/${w.projectId}/feedback/${fb}/messages`, body);

  it('names the holders of feedback.approve as owing the relay, on their Needs you', async () => {
    const { fb } = await agentItem('0.4.0');
    const d = await detail(fb);
    expect(d.phase).toBe('resolved');
    expect(d.shipNotice).toMatchObject({ state: 'not_told' });
    expect(d.attentionGroup, "the relay is on the triager's Needs you").toBe('needs_you');
    expect((d.waitingOn as Body).kind).toBe('you');
    expect(String((d.waitingOn as Body).act)).toMatch(/^tell .+ that it shipped in 0\.4\.0$/);
    const list = await api(w.token, 'GET', `/api/projects/${w.projectId}/feedback`);
    const row = (list.body.feedback as Body[]).find((f) => f.key === fb);
    expect(row?.attentionGroup).toBe('needs_you');
  });

  it('refuses a relay told to nobody, and a bell message to a reporter with no bell, by name', async () => {
    const { fb } = await agentItem('0.4.1');
    const internal = await send(fb, { audience: 'internal', text: 'told them', relayed: true });
    expect(internal.status).toBe(422);
    expect(JSON.stringify(internal.body)).toContain('FEEDBACK_RELAY_NOT_TO_REPORTERS');
    const bell = await send(fb, { audience: 'reporter', text: 'It shipped.' });
    expect(bell.status).toBe(422);
    expect(JSON.stringify(bell.body)).toContain('FEEDBACK_MESSAGE_NO_RECIPIENT');
    expect(JSON.stringify(bell.body)).toContain('relayed: true');
    const empty = await send(fb, { audience: 'reporter', text: '  ', relayed: true });
    expect(JSON.stringify(empty.body)).toContain('FEEDBACK_MESSAGE_EMPTY');
    const preview = await api(
      w.token,
      'POST',
      `/api/projects/${w.projectId}/feedback/${fb}/messages/preview`,
      { audience: 'reporter', text: 'It shipped.', relayed: true },
    );
    expect(preview.status).toBe(422);
    expect(JSON.stringify(preview.body)).toContain('/relayed');
  });

  it('reads told once a person records the relay, and leaves their Needs you', async () => {
    const { fb } = await agentItem('0.4.2');
    const res = await send(fb, {
      audience: 'reporter',
      text: 'Told them in the support thread: 0.4.2 fixes the export.',
      relayed: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const d = res.body.feedback as Body;
    expect(d.shipNotice).toMatchObject({ state: 'told', how: 'relayed', release: '0.4.2' });
    expect(((d.shipNotice as Body).says as Body).told).toMatchObject({
      key: 'feedback.told.relayed',
    });
    expect(saidDisagreements(d)).toEqual([]);
    expect(((d.shipNotice as Body).by as string | null) ?? '').not.toBe('');
    expect(d.attentionGroup).not.toBe('needs_you');
    expect((d.waitingOn as Body).act).toBe('verify the fix shipped in 0.4.2');
    const [m] = d.messages as Body[];
    expect(m).toMatchObject({ audience: 'reporter', relayed: true, recipients: [] });
    expect(
      (await notices('feedback_message')).filter((n) => n.title.includes(fb)),
      'a relay sends no notice',
    ).toEqual([]);
    const rel = await api(w.token, 'GET', `/api/projects/${w.projectId}/releases/0.4.2`);
    const answered = (rel.body.release as Body).feedbackAnswered as Body[];
    expect(answered.find((f) => f.key === fb)?.told).toBe('told');
  });
});
