/**
 * ISS-1229 r13 — the bell shows one row per notice, dates a group and its members on one clock, counts
 * the rows it shows rather than the records inside them, and keeps the sentence a notice was
 * delivered with. Each case was planted against the old route and seen red before the fix; round 14
 * adds that an invitation counts as the pending invitation the bell offers, never as its record.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { type InboxRow, registerInboxFixture } from '../helpers/inbox-fixture.js';

const fx = registerInboxFixture();
const { announce, auth, inbox, membersOf, seedShipped, sweepRows } = fx;

describe('one bell row per notice, one clock, one count (ISS-1229 r13)', () => {
  it('counts the open rows the bell shows, so a group of three reads one', async () => {
    await seedShipped(61, 'Repair invoice export');
    await seedShipped(62, 'Retry failed webhooks');
    await seedShipped(63, 'Trim the audit log');
    await announce(() => fx.mods.detectOwedCloses());
    expect(sweepRows(await inbox())).toHaveLength(1);

    const res = await fx.app.request('/api/notifications/open-count', { headers: auth() });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { count: number }).count).toBe(1);
  });

  it('counts an invitation once while the bell offers it, never a record whose invitation is gone', async () => {
    // Two invitation records the bell never shows: their invitations were accepted long ago, so the
    // panel offers neither, and judge-35 read a badge 4 above the rows behind it (ISS-1229 r14).
    for (const title of [
      'Ann invited you to Billing as member',
      'Bo invited you to Ledger as admin',
    ]) {
      await fx.mods.recordAndDeliver({
        recipients: [fx.owner],
        projectId: fx.project.id,
        type: 'invitation_received',
        title,
      });
    }
    await seedShipped(64, 'Close the ledger export');
    await announce(() => fx.mods.detectOwedCloses());
    const openCount = async () => {
      const res = await fx.app.request('/api/notifications/open-count', { headers: auth() });
      expect(res.status).toBe(200);
      return ((await res.json()) as { count: number }).count;
    };
    expect(await openCount()).toBe(1);

    // An invitation still pending is a row the bell offers, so it counts, once.
    const [reader] = (await fx.db.execute(
      sql`SELECT email FROM users WHERE id = ${fx.owner}`,
    )) as unknown as { email: string }[];
    const email = reader?.email ?? '';
    expect(email).not.toBe('');
    await fx.db.execute(sql`
      INSERT INTO project_invitations (token, project_id, email, role, inviter_id, expires_at)
      VALUES ('pending-r14', ${fx.project.id}, ${email.toUpperCase()}, 'member', ${fx.owner},
              now() + interval '7 days')
    `);
    expect(await openCount()).toBe(2);
  });

  it('dates each member by when it reached the reader, and the row by its newest member', async () => {
    const t0 = new Date('2026-10-17T10:00:00.000Z');
    const t1 = new Date('2026-10-17T10:02:00.000Z');
    const grouped = {
      recipients: [fx.owner],
      projectId: fx.project.id,
      groupKey: 'g:clock',
      groupTitle: 'Two things',
    };
    await fx.mods.recordAndDeliver(
      { ...grouped, type: 'issue_status_changed', title: 'first' },
      t0,
    );
    await fx.mods.recordAndDeliver(
      { ...grouped, type: 'issue_status_changed', title: 'second' },
      t1,
    );

    const [row] = (await inbox()).items as [InboxRow];
    expect(row.members).toBe(2);
    expect(new Date(row.toldAt).toISOString()).toBe(t1.toISOString());
    const members = await membersOf(row.id);
    const when = Object.fromEntries(
      members.map((m) => [m.title, new Date(m.deliveredAt).toISOString()]),
    );
    expect(when).toEqual({
      'Invoicing — first': t0.toISOString(),
      'Invoicing — second': t1.toISOString(),
    });
  });

  it('keeps the sentence a condition was delivered with, however often it is seen after', async () => {
    const issueId = await seedShipped(64, 'Repair invoice export');
    const at = (m: number) => new Date(Date.parse('2026-10-17T10:00:00.000Z') + m * 60_000);
    const raise = (body: string, m: number) =>
      fx.mods.recordAndDeliver(
        {
          recipients: [fx.owner],
          projectId: fx.project.id,
          issueId,
          type: 'issue_stranded',
          title: 'stuck',
          body,
          resolutionKey: 'stuck:64',
        },
        at(m),
      );
    await raise('stood 15 minutes', 0);
    await raise('stood 17 minutes', 2);
    await raise('stood 19 minutes', 4);
    await raise('stood 26 minutes', 11);

    const [stored] = (await fx.db.execute(
      sql`SELECT state, body FROM notifications WHERE resolution_key = 'stuck:64'`,
    )) as unknown as Array<{ state: string; body: string }>;
    expect(stored?.state).toBe('firing');
    expect(stored?.body).toBe('stood 17 minutes');
  });

  it('keeps the sentence a person was told, not one a silenced sighting carried', async () => {
    const issueId = await seedShipped(65, 'Retry failed webhooks');
    const at = (m: number) => new Date(Date.parse('2026-10-17T10:00:00.000Z') + m * 60_000);
    await fx.db.execute(sql`
      INSERT INTO notification_silences (created_by, resolution_key, reason, expires_at)
      VALUES (${fx.owner}, 'stuck:65', 'on leave', ${at(6).toISOString()})
    `);
    const { hooks } = await import('../../src/pipeline/hooks.js');
    const emitted: Array<string | null> = [];
    const off = hooks.on('notificationCreated', (p) => {
      emitted.push(p.body ?? null);
    });
    const raise = (body: string, m: number) =>
      fx.mods.recordAndDeliver(
        {
          recipients: [fx.owner],
          projectId: fx.project.id,
          issueId,
          type: 'issue_stranded',
          title: 'stuck',
          body,
          resolutionKey: 'stuck:65',
        },
        at(m),
      );
    try {
      await raise('stood 15 minutes', 0);
      await raise('stood 17 minutes', 2);
      await raise('stood 19 minutes', 4);
      expect(await inbox().then((p) => p.items)).toHaveLength(0);
      await raise('stood 23 minutes', 8);
      await raise('stood 30 minutes', 15);
    } finally {
      off();
    }

    const [row] = (await inbox()).items as [InboxRow];
    expect(row.body).toBe('stood 23 minutes');
    expect(emitted).toEqual(['stood 23 minutes']);
  });
});
