/**
 * The bell's badge and its list read one population: the badge counts the rows the bell lists as
 * still open, so a grouped delivery folding fifteen firing strands is one open row and one on the
 * badge (FB-76: the badge read 136, 99+, against 21 open rows once dev.54 folded the strands).
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { createTestProject, createTestUser } from '../helpers/factories.js';

let reader = '';
let other = '';
let token = '';
let atlas = '';
let borea = '';

type Shape = { kind: 'condition' | 'signal' | 'task'; state: string; resolved?: boolean };

async function record(projectId: string, s: Shape): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO notifications (id, project_id, type, kind, tier, state, title, severity, resolved_at)
    VALUES (${id}, ${projectId}, ${s.kind === 'signal' ? 'issue_status_changed' : 'issue_stranded'},
            ${s.kind}, ${s.kind === 'signal' ? 'log' : 'ticket'}, ${s.state}, ${`record ${id.slice(0, 8)}`},
            'warning', ${s.resolved ? new Date().toISOString() : null})
  `);
  return id;
}

async function delivery(
  userId: string,
  records: string[],
  opts: { groupKey?: string; resolvedNotice?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO notification_deliveries (id, user_id, group_key, resolved_notice)
    VALUES (${id}, ${userId}, ${opts.groupKey ?? null}, ${opts.resolvedNotice ?? false})
  `);
  for (const r of records) {
    await db.execute(
      sql`INSERT INTO notification_delivery_members (delivery_id, notification_id) VALUES (${id}, ${r})`,
    );
  }
  return id;
}

const firing = { kind: 'condition', state: 'firing' } as const;

async function openCount(query = ''): Promise<number> {
  const res = await api(token, 'GET', `/api/notifications/open-count${query}`);
  expect(res.status).toBe(200);
  return res.body.count as number;
}

async function openRows(query = ''): Promise<number> {
  const res = await api(token, 'GET', `/api/notifications?openOnly=true&pageSize=100${query}`);
  expect(res.status).toBe(200);
  return res.body.total as number;
}

beforeAll(async () => {
  reader = (await createTestUser({ verified: true })).id;
  other = (await createTestUser({ verified: true })).id;
  token = await userToken(reader);
  atlas = (await createTestProject(reader)).id;
  borea = (await createTestProject(reader)).id;

  const strands = await Promise.all(Array.from({ length: 15 }, () => record(atlas, firing)));
  await delivery(reader, strands, { groupKey: `sweep:idle-issues:${atlas}` });
  await delivery(reader, [await record(atlas, firing)]);
  await delivery(reader, [await record(borea, { kind: 'task', state: 'open' })]);

  const cleared = await record(atlas, { kind: 'condition', state: 'resolved', resolved: true });
  await delivery(reader, [cleared]);
  await delivery(reader, [cleared], { resolvedNotice: true });
  await delivery(reader, [await record(atlas, { kind: 'signal', state: 'emitted' })]);
  await delivery(reader, [await record(atlas, { kind: 'condition', state: 'pending' })]);
  await delivery(other, [await record(atlas, firing)]);
});

describe('the bell badge', () => {
  it('counts a grouped delivery of fifteen firing records as the one open row the bell lists', async () => {
    expect(await openCount()).toBe(3);
  });

  it('reads the same number as the open rows the list serves', async () => {
    expect(await openCount()).toBe(await openRows());
  });

  it('narrows to one project the way the list does', async () => {
    expect(await openCount(`?projectId=${atlas}`)).toBe(2);
    expect(await openCount(`?projectId=${borea}`)).toBe(await openRows(`&projectId=${borea}`));
  });

  it('drops a row once its last record clears', async () => {
    await db.execute(sql`
      UPDATE notifications SET state = 'done', resolved_at = now()
       WHERE project_id = ${borea} AND kind = 'task'
    `);
    expect(await openCount()).toBe(2);
    expect(await openRows()).toBe(2);
  });
});

/**
 * ISS-289: the bell now lists `openOnly=true`, so that list has to describe each open delivery whole.
 * Selecting open deliveries by dropping their cleared records from the join made a group of three
 * with two still firing read "2 of 2 still open"; and a resolved notice is no open row on either side.
 */
describe('the open list the bell reads', () => {
  let grouper = '';
  let groupToken = '';
  let group = '';

  beforeAll(async () => {
    grouper = (await createTestUser({ verified: true })).id;
    groupToken = await userToken(grouper);
    const cleared = await record(atlas, { kind: 'condition', state: 'resolved', resolved: true });
    const members = [await record(atlas, firing), await record(atlas, firing), cleared];
    group = await delivery(grouper, members, { groupKey: `sweep:idle-issues:${atlas}:289` });
    await delivery(grouper, [await record(atlas, firing)], { resolvedNotice: true });
  });

  async function listed(): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const res = await api(groupToken, 'GET', '/api/notifications?openOnly=true&pageSize=100');
    expect(res.status).toBe(200);
    return res.body as { items: Record<string, unknown>[]; total: number };
  }

  it('reads a grouped delivery whole: every record it carries, and how many are still open', async () => {
    const row = (await listed()).items.find((i) => i.id === group);
    expect(row).toMatchObject({ members: 3, openMembers: 2 });
  });

  it('leaves a resolved notice out of the list as the badge leaves it out of the count', async () => {
    const res = await api(groupToken, 'GET', '/api/notifications/open-count');
    expect(res.status).toBe(200);
    const list = await listed();
    expect(list.items.map((i) => i.id)).toEqual([group]);
    expect(list.total).toBe(res.body.count);
    expect(res.body.count).toBe(1);
  });
});

/**
 * Open is a fact about the records behind a delivery, never about whether anyone has looked: a read
 * delivery whose record still fires is listed and counted beside an unread one. Nothing guarded this
 * until ISS-277, and `openDelivery` redefined as unread left every suite green (ISS-289's judge).
 */
describe('a read delivery that is still open', () => {
  let looker = '';
  let lookerToken = '';
  let seen = '';
  let unseen = '';

  beforeAll(async () => {
    looker = (await createTestUser({ verified: true })).id;
    lookerToken = await userToken(looker);
    seen = await delivery(looker, [await record(atlas, firing)]);
    unseen = await delivery(looker, [await record(atlas, firing)]);
    await db.execute(sql`UPDATE notification_deliveries SET read_at = now() WHERE id = ${seen}`);
  });

  it('is listed and counted beside the unread one', async () => {
    const list = await api(lookerToken, 'GET', '/api/notifications?openOnly=true&pageSize=100');
    const count = await api(lookerToken, 'GET', '/api/notifications/open-count');
    expect(list.status).toBe(200);
    expect(count.status).toBe(200);
    const ids = (list.body.items as Record<string, unknown>[]).map((i) => i.id);
    expect(ids.sort()).toEqual([seen, unseen].sort());
    expect(count.body.count).toBe(2);
  });
});
