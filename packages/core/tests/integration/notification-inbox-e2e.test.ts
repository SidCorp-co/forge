/**
 * ISS-1168 — the inbox names what each row is about, opens it, shows a sweep once, lets a resolved
 * row leave the unread set, and filters before it paginates.
 *
 * ISS-1063 split the record from the delivery and grouped a sweep into one delivery per reader.
 * What was left, and what every case below plants and watches go red before the fix: the list route
 * titled a delivery holding ONE record by the detector's cause, read a group's body and issue off
 * `min()` of its members, wrote a resolved notice unread, and knew no filter.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { type InboxRow, registerInboxFixture } from '../helpers/inbox-fixture.js';
import { createTestProject } from '../helpers/index.js';

const OWED_CLOSE_CAUSE = 'Issues whose code shipped and whose close was never written';

const fx = registerInboxFixture();
const { announce, auth, inbox, markRead, membersOf, seedShipped, sweepRows } = fx;

describe('a sweep over several issues', () => {
  it('arrives as one row carrying its count, titled by its cause, naming no single issue', async () => {
    await seedShipped(41, 'Repair invoice export');
    await seedShipped(42, 'Retry failed webhooks');
    await seedShipped(43, 'Trim the audit log');
    const told = await announce(() => fx.mods.detectOwedCloses());
    expect(told.detected).toBe(3);

    const rows = sweepRows(await inbox());
    expect(rows).toHaveLength(1);
    const [row] = rows as [InboxRow];
    expect(row.members).toBe(3);
    expect(row.title).toBe(OWED_CLOSE_CAUSE);
    // A group points at no one issue and carries no member's text as its own: `min()` of three
    // members is an arbitrary one of them.
    expect(row.issueId).toBeNull();
    expect(row.body).toBeNull();
    expect(row.explanation).toMatch(/close/i);
  });

  it('expands to members that each name their own issue, open it, and hold only what is specific', async () => {
    const a = await seedShipped(41, 'Repair invoice export');
    await seedShipped(42, 'Retry failed webhooks');
    await announce(() => fx.mods.detectOwedCloses());

    const [row] = sweepRows(await inbox()) as [InboxRow];
    const members = await membersOf(row.id);
    expect(members).toHaveLength(2);
    for (const m of members) {
      expect(m.title).toMatch(/ISS-4[12]/);
      expect(m.issueId).not.toBeNull();
      expect(m.projectSlug).toBe(fx.project.slug);
      expect(m.body ?? '').toContain(m.title.match(/ISS-4[12]/)?.[0] ?? 'no ref');
      // The explanation is the detector's, shown once on the row: a member repeating it is the
      // sentence on every item the audit counted.
      expect(m.body ?? '').not.toContain(row.explanation ?? 'no explanation');
    }
    expect(members.map((m) => m.issueId)).toContain(a);
  });
});

describe('a sweep over one issue', () => {
  it('is titled by its subject, not by the detector, and opens that issue', async () => {
    const id = await seedShipped(41, 'Repair invoice export');
    await announce(() => fx.mods.detectOwedCloses());

    const [row] = sweepRows(await inbox()) as [InboxRow];
    expect(row.members).toBe(1);
    expect(row.title).toContain('ISS-41');
    expect(row.title).not.toBe(OWED_CLOSE_CAUSE);
    expect(row.body ?? '').toContain('ISS-41');
    expect(row.issueId).toBe(id);
    expect(row.projectSlug).toBe(fx.project.slug);
    expect(row.projectName).toBe('Invoicing');
    expect(row.explanation).toMatch(/close/i);
  });
});

describe('a notification written against an issue', () => {
  async function issue(seq: number): Promise<string> {
    return seedShipped(seq, 'Repair invoice export');
  }

  it('names the issue by its reference whichever producer wrote it', async () => {
    const issueId = await issue(77);
    await fx.mods.recordAndDeliver({
      recipients: [fx.owner],
      projectId: fx.project.id,
      issueId,
      type: 'pipeline_wedge',
      title: 'Pipeline wedge: heartbeat hop miss on job',
      resolutionKey: 'wedge:job-1',
    });
    const [row] = (await inbox()).items as [InboxRow];
    expect(row.title).toBe('ISS-77 — Pipeline wedge: heartbeat hop miss on job');
  });

  it('does not name it twice where the producer already did', async () => {
    const issueId = await issue(78);
    await fx.mods.recordAndDeliver({
      recipients: [fx.owner],
      projectId: fx.project.id,
      issueId,
      type: 'pipeline_wedge',
      title: 'ISS-78 says work is in progress with no run behind it',
      resolutionKey: 'wedge:job-2',
    });
    const [row] = (await inbox()).items as [InboxRow];
    expect(row.title).toBe('ISS-78 says work is in progress with no run behind it');
  });

  it('names the project where the notification is about no issue and nothing finer', async () => {
    await fx.mods.recordAndDeliver({
      recipients: [fx.owner],
      projectId: fx.project.id,
      type: 'pipeline_wedge',
      title: 'A runner can no longer authenticate',
      resolutionKey: 'wedge:runner-1',
    });
    const [row] = (await inbox()).items as [InboxRow];
    expect(row.title).toBe('Invoicing — A runner can no longer authenticate');
    expect(row.projectSlug).toBe(fx.project.slug);
  });
});

describe('unread is state, not text', () => {
  async function dbRead(deliveryId: string): Promise<Date | null> {
    const [r] = (await fx.db.execute(
      sql`SELECT read_at FROM notification_deliveries WHERE id = ${deliveryId}`,
    )) as unknown as { read_at: Date | null }[];
    return r?.read_at ?? null;
  }

  it('takes a delivery out of the unread set once every record it carries has resolved, and the resolved notice with it', async () => {
    const issueId = await seedShipped(50, 'Repair invoice export');
    await fx.mods.recordAndDeliver({
      recipients: [fx.owner],
      projectId: fx.project.id,
      issueId,
      type: 'pipeline_wedge',
      title: 'ISS-50 is wedged',
      resolutionKey: 'wedge:50',
    });
    const before = (await inbox()).items;
    expect(before).toHaveLength(1);
    expect(before[0]?.unread).toBe(true);

    await fx.mods.resolveNotifications('wedge:50');

    // ISS-1229 r13: one resolution, one row — the row that raised it, marked resolved, and not a
    // second "Resolved —" row beside it.
    const after = (await inbox()).items;
    expect(after).toHaveLength(1);
    const original = after[0] as InboxRow;
    expect(original.resolvedNotice).toBe(false);
    expect(original.openMembers).toBe(0);
    expect(original.unread).toBe(false);
    // Nothing wrote a read stamp for a person who has not looked: it is derived.
    expect(await dbRead(original.id)).toBeNull();
  });

  it('keeps a delivery holding a still-true record unread until a person reads it', async () => {
    await fx.mods.recordAndDeliver({
      recipients: [fx.owner],
      projectId: fx.project.id,
      type: 'pipeline_wedge',
      title: 'A step is held',
      resolutionKey: 'wedge:held',
    });
    const [row] = (await inbox()).items as [InboxRow];
    expect(row.unread).toBe(true);
    await markRead(row.id);
    const [read] = (await inbox()).items as [InboxRow];
    expect(read.unread).toBe(false);
  });

  it('keeps an event unread until it is read, since an event cannot resolve', async () => {
    await fx.mods.recordAndDeliver({
      recipients: [fx.owner],
      projectId: fx.project.id,
      type: 'issue_status_changed',
      title: 'ISS-1 moved to closed',
    });
    const [row] = (await inbox()).items as [InboxRow];
    expect(row.unread).toBe(true);
    await markRead(row.id);
    expect(((await inbox()).items[0] as InboxRow).unread).toBe(false);
  });
});

describe('the list filters before it paginates', () => {
  async function seedMixed() {
    for (let i = 0; i < 5; i += 1) {
      await fx.mods.recordAndDeliver({
        recipients: [fx.owner],
        projectId: fx.project.id,
        type: 'pipeline_wedge',
        title: `Wedge ${i}`,
        resolutionKey: `wedge:mixed-${i}`,
      });
    }
    for (let i = 0; i < 3; i += 1) {
      await fx.mods.recordAndDeliver({
        recipients: [fx.owner],
        projectId: fx.project.id,
        type: 'ops_alert',
        title: `Ops ${i}`,
        resolutionKey: `ops:mixed-${i}`,
      });
    }
    for (let i = 0; i < 2; i += 1) {
      await fx.mods.recordAndDeliver({
        recipients: [fx.owner],
        projectId: fx.project.id,
        type: 'issue_status_changed',
        title: `Moved ${i}`,
      });
    }
    const wedges = (await inbox('?type=pipeline_wedge')).items;
    await markRead((wedges[0] as InboxRow).id);
    await markRead((wedges[1] as InboxRow).id);
  }

  it('counts and pages only the rows of one type that are unread', async () => {
    await seedMixed();
    const first = await inbox('?type=pipeline_wedge&unread=true&pageSize=2&page=1');
    expect(first.total).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = await inbox('?type=pipeline_wedge&unread=true&pageSize=2&page=2');
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    const seen = [...first.items, ...second.items];
    expect(new Set(seen.map((r) => r.id)).size).toBe(3);
    expect(seen.every((r) => r.type === 'pipeline_wedge' && r.unread)).toBe(true);
  });

  it('filters by unread alone and by type alone', async () => {
    await seedMixed();
    expect((await inbox('?unread=true')).total).toBe(8);
    expect((await inbox('?type=ops_alert')).total).toBe(3);
    expect((await inbox()).total).toBe(10);
  });

  it('keeps a group whole when a filter would leave one of its records', async () => {
    const other = await createTestProject(fx.db, fx.owner, { name: 'Billing' });
    const groupKey = 'sweep:owed-close:29866100';
    const groupTitle = 'Issues whose code shipped and whose close was never written';
    for (const [n, projectId] of [
      [1, fx.project.id],
      [2, other.id],
    ] as const) {
      await fx.mods.recordAndDeliver({
        recipients: [fx.owner],
        projectId,
        type: 'pipeline_wedge',
        title: `Record ${n}`,
        resolutionKey: `wedge:cross-${n}`,
        groupKey,
        groupTitle,
      });
    }
    for (const query of [
      `?projectId=${fx.project.id}`,
      `?projectId=${other.id}`,
      '?openOnly=true',
    ]) {
      const page = await inbox(query);
      expect(page.total, query).toBe(1);
      const [row] = page.items as [InboxRow];
      expect(row.members, query).toBe(2);
      expect(row.title, query).toBe(groupTitle);
      expect(row.issueId, query).toBeNull();
      expect(row.projectId, query).toBeNull();
    }
  });

  it('refuses a type nothing writes, by name', async () => {
    const res = await fx.app.request('/api/notifications?type=comment_added', { headers: auth() });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('type');
  });
});

describe('a delivery written before this change', () => {
  it('is listed under its record’s own title with its stored body, and is not rewritten', async () => {
    const issueId = await seedShipped(9, 'Repair invoice export');
    const legacyBody =
      'Its code has carried a merge mark for 3 days while the issue still reads `waiting`, and nothing is running on it. The step that owed the close did not write it.';
    const [rec] = (await fx.db.execute(sql`
      INSERT INTO notifications (project_id, type, kind, tier, state, title, body, resolution_key, issue_id, group_key, pending_since, last_seen_at)
      VALUES (${fx.project.id}, 'issue_stranded', 'condition', 'ticket', 'firing',
              'ISS-9 shipped but never closed — Invoicing', ${legacyBody},
              ${`issue:${issueId}:owed-close`}, ${issueId}, 'sweep:owed-close:29866100', now(), now())
      RETURNING id
    `)) as unknown as { id: string }[];
    const [del] = (await fx.db.execute(sql`
      INSERT INTO notification_deliveries (user_id, channel, group_key, title)
      VALUES (${fx.owner}, 'bell', 'sweep:owed-close:29866100', ${OWED_CLOSE_CAUSE})
      RETURNING id
    `)) as unknown as { id: string }[];
    await fx.db.execute(sql`
      INSERT INTO notification_delivery_members (delivery_id, notification_id)
      VALUES (${(del as { id: string }).id}, ${(rec as { id: string }).id})
    `);

    const snapshot = async () =>
      JSON.stringify([
        await fx.db.execute(sql`SELECT * FROM notifications ORDER BY id`),
        await fx.db.execute(sql`SELECT * FROM notification_deliveries ORDER BY id`),
        await fx.db.execute(sql`SELECT * FROM notification_delivery_members ORDER BY 1, 2`),
      ]);
    const before = await snapshot();

    const [row] = (await inbox()).items as [InboxRow];
    expect(row.title).toBe('ISS-9 shipped but never closed — Invoicing');
    expect(row.body).toBe(legacyBody);
    expect(row.issueId).toBe(issueId);
    expect(await snapshot()).toBe(before);
  });
});
