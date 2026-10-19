/**
 * ISS-1229 r13 — the bell shows one row per notice, dates a group and its members on one clock, counts
 * the rows it shows rather than the records inside them, and keeps the sentence a notice was
 * delivered with. Each case was planted against the old route and seen red before the fix; round 14
 * adds that an invitation counts as the pending invitation the bell offers, never as its record.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestProject, createTestUser } from '../helpers/factories.js';
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

// ISS-1229 r15, from judge-38's reader notes and the master's brief: a stuck row was tagged STRANDED,
// a word none of the group titles says, and a project's records still counted once it was archived.
describe('a stuck row by its kind, and nothing of an archived project (ISS-1229 r15)', () => {
  const openCount = async () => {
    const res = await fx.app.request('/api/notifications/open-count', { headers: auth() });
    expect(res.status).toBe(200);
    return ((await res.json()) as { count: number }).count;
  };

  it('names the kind a stuck row tells, which its tag is drawn from', async () => {
    await seedShipped(71, 'Repair invoice export');
    await announce(() => fx.mods.detectOwedCloses());
    const [row] = sweepRows(await inbox()) as Array<InboxRow & { stuckKind: string | null }>;
    expect(row?.stuckKind).toBe('owed_close');
  });

  it('neither counts nor lists a row whose records are all about an archived project', async () => {
    await seedShipped(72, 'Repair invoice export');
    await announce(() => fx.mods.detectOwedCloses());
    expect(await openCount()).toBe(1);
    expect(sweepRows(await inbox())).toHaveLength(1);

    await fx.db.execute(sql`UPDATE projects SET archived_at = now() WHERE id = ${fx.project.id}`);
    // Nor an invitation to it, which the bell would otherwise offer and count.
    await fx.db.execute(sql`
      INSERT INTO project_invitations (token, project_id, email, role, inviter_id, expires_at)
      SELECT 'archived-r15', ${fx.project.id}, email, 'member', ${fx.owner}, now() + interval '7 days'
        FROM users WHERE id = ${fx.owner}
    `);

    expect(await openCount()).toBe(0);
    expect(sweepRows(await inbox())).toHaveLength(0);
    expect(sweepRows(await inbox('?unread=true'))).toHaveLength(0);
  });

  it("counts only a grouped row's records about live projects, and lists only those as its members", async () => {
    const other = await createTestProject(fx.db, fx.owner, { name: 'Ledger' });
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await fx.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, created_by_id, merged_at, iss_seq, updated_at)
      VALUES (${crypto.randomUUID()}, ${other.id}, 'Close the ledger', 'waiting', ${fx.owner},
              ${longAgo}, 1, ${longAgo})
    `);
    await seedShipped(73, 'Repair invoice export');
    await announce(() => fx.mods.detectOwedCloses());
    const [before] = sweepRows(await inbox());
    expect(before?.members).toBe(2);

    await fx.db.execute(sql`UPDATE projects SET archived_at = now() WHERE id = ${other.id}`);

    const [row] = sweepRows(await inbox());
    expect({ members: row?.members, open: row?.openMembers }).toEqual({ members: 1, open: 1 });
    expect((await membersOf(row?.id ?? '')).map((m) => m.title)).toEqual([
      expect.stringContaining('Invoicing'),
    ]);
  });
});

// ISS-1229 r15, the master's ruling: an issue the reader's failed jobs list was also a NO LIVE WORK bell
// row. One issue is one row: its failed job tells it, so the bell neither counts nor lists its notice,
// and tells it again once the failed job is retried.
describe("a stuck issue the reader's failed job tells, in the bell", () => {
  const openCount = async () => {
    const res = await fx.app.request('/api/notifications/open-count', { headers: auth() });
    expect(res.status).toBe(200);
    return ((await res.json()) as { count: number }).count;
  };

  it('is neither counted nor listed while the failed job stands', async () => {
    const issue = await seedShipped(91, 'Export the March invoices');
    await announce(() => fx.mods.detectOwedCloses());
    expect(await openCount()).toBe(1);

    // Another person's issue, so the reader owes it no answer; the failed job is the reader's.
    const other = await createTestUser(fx.db);
    await fx.db.execute(sql`UPDATE issues SET assignee_id = ${other.id} WHERE id = ${issue}`);
    const run = crypto.randomUUID();
    const job = crypto.randomUUID();
    await fx.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
      VALUES (${run}, ${fx.project.id}, 'system', 'failed', now())
    `);
    await fx.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, issue_id, type, status, created_by, error)
      VALUES (${job}, ${fx.project.id}, ${run}, ${issue}, 'drive', 'failed', ${fx.owner}, 'session_lost')
    `);

    expect(await openCount()).toBe(0);
    expect(sweepRows(await inbox())).toHaveLength(0);

    await fx.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, issue_id, type, status, created_by, retry_of)
      VALUES (${crypto.randomUUID()}, ${fx.project.id}, ${run}, ${issue}, 'drive', 'queued', ${fx.owner}, ${job})
    `);
    expect(await openCount()).toBe(1);
    expect(sweepRows(await inbox())).toHaveLength(1);
  });
});
