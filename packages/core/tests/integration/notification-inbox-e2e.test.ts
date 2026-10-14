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
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  recordAndDeliver: typeof import('../../src/notifications/deliver.js').recordAndDeliver;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  resolveNotifications: typeof import('../../src/notifications/auto-resolve.js').resolveNotifications;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  detectOwedCloses: typeof import('../../src/pipeline/stranded-issues.js').detectOwedCloses;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  detectStrandedIssues: typeof import('../../src/pipeline/stranded-issues.js').detectStrandedIssues;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  owedCloseResolutionKey: typeof import('../../src/pipeline/stranded-issues.js').owedCloseResolutionKey;
};

type Row = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  unread: boolean;
  readAt: string | null;
  members: number;
  openMembers: number;
  issueId: string | null;
  projectId: string | null;
  projectSlug: string | null;
  projectName: string | null;
  explanation: string | null;
  groupKey: string | null;
  resolvedNotice: boolean;
};
type Page = { items: Row[]; total: number; hasMore: boolean };
type Member = {
  id: string;
  title: string;
  body: string | null;
  issueId: string | null;
  projectSlug: string | null;
  open: boolean;
};

const HOUR = 60 * 60 * 1000;
const OWED_CLOSE_CAUSE = 'Issues whose code shipped and whose close was never written';

let harness: TestDatabase;
let mods: Mods;
let app: Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>;
let owner: string;
let project: { id: string; slug: string; name: string };
let token: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const deliver = await import('../../src/notifications/deliver.js');
  const resolve = await import('../../src/notifications/auto-resolve.js');
  const stranded = await import('../../src/pipeline/stranded-issues.js');
  mods = {
    recordAndDeliver: deliver.recordAndDeliver,
    resolveNotifications: resolve.resolveNotifications,
    detectOwedCloses: stranded.detectOwedCloses,
    detectStrandedIssues: stranded.detectStrandedIssues,
    owedCloseResolutionKey: stranded.owedCloseResolutionKey,
  };

  const { notificationRoutes } = await import('../../src/notifications/routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/notifications', notificationRoutes);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  owner = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  project = await createTestProject(harness.db, owner, { name: 'Invoicing' });
  const { signUserToken } = await import('../../src/auth/jwt.js');
  token = await signUserToken(owner);
});

const auth = () => ({ authorization: `Bearer ${token}` });

async function inbox(query = ''): Promise<Page> {
  const res = await app.request(`/api/notifications${query}`, { headers: auth() });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { items: Row[]; total: number; hasMore: boolean };
  return { items: body.items, total: body.total, hasMore: body.hasMore };
}

async function membersOf(deliveryId: string): Promise<Member[]> {
  const res = await app.request(`/api/notifications/${deliveryId}/members`, { headers: auth() });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as Member[];
}

function markRead(deliveryId: string) {
  return app.request(`/api/notifications/${deliveryId}`, {
    method: 'PATCH',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify({ read: true }),
  });
}

/** A merged issue parked under a live status with nothing running: what the owed-close sweep reads. */
async function seedShipped(seq: number, title: string): Promise<string> {
  const id = crypto.randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, created_by_id, merged_at, iss_seq, updated_at)
    VALUES (${id}, ${project.id}, ${title}, 'waiting', ${owner},
            ${new Date(Date.now() - 48 * HOUR).toISOString()}, ${seq},
            ${new Date(Date.now() - 48 * HOUR).toISOString()})
  `);
  return id;
}

/** Run a detector until it tells somebody: a stranded condition waits two evaluations. */
async function announce(detect: () => Promise<{ detected: number; notified: number }>) {
  await detect();
  await harness.db.execute(
    sql`UPDATE notifications SET pending_since = now() - interval '10 minutes'`,
  );
  return detect();
}

const sweepRows = (page: Page) => page.items.filter((r) => r.type === 'issue_stranded');

describe('a sweep over several issues', () => {
  it('arrives as one row carrying its count, titled by its cause, naming no single issue', async () => {
    await seedShipped(41, 'Repair invoice export');
    await seedShipped(42, 'Retry failed webhooks');
    await seedShipped(43, 'Trim the audit log');
    const told = await announce(() => mods.detectOwedCloses());
    expect(told.detected).toBe(3);

    const rows = sweepRows(await inbox());
    expect(rows).toHaveLength(1);
    const [row] = rows as [Row];
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
    await announce(() => mods.detectOwedCloses());

    const [row] = sweepRows(await inbox()) as [Row];
    const members = await membersOf(row.id);
    expect(members).toHaveLength(2);
    for (const m of members) {
      expect(m.title).toMatch(/ISS-4[12]/);
      expect(m.issueId).not.toBeNull();
      expect(m.projectSlug).toBe(project.slug);
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
    await announce(() => mods.detectOwedCloses());

    const [row] = sweepRows(await inbox()) as [Row];
    expect(row.members).toBe(1);
    expect(row.title).toContain('ISS-41');
    expect(row.title).not.toBe(OWED_CLOSE_CAUSE);
    expect(row.body ?? '').toContain('ISS-41');
    expect(row.issueId).toBe(id);
    expect(row.projectSlug).toBe(project.slug);
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
    await mods.recordAndDeliver({
      recipients: [owner],
      projectId: project.id,
      issueId,
      type: 'pipeline_wedge',
      title: 'Pipeline wedge: heartbeat hop miss on job',
      resolutionKey: 'wedge:job-1',
    });
    const [row] = (await inbox()).items as [Row];
    expect(row.title).toBe('ISS-77 — Pipeline wedge: heartbeat hop miss on job');
  });

  it('does not name it twice where the producer already did', async () => {
    const issueId = await issue(78);
    await mods.recordAndDeliver({
      recipients: [owner],
      projectId: project.id,
      issueId,
      type: 'pipeline_wedge',
      title: 'ISS-78 says work is in progress with no run behind it',
      resolutionKey: 'wedge:job-2',
    });
    const [row] = (await inbox()).items as [Row];
    expect(row.title).toBe('ISS-78 says work is in progress with no run behind it');
  });

  it('leaves a title alone where the notification is about no issue', async () => {
    await mods.recordAndDeliver({
      recipients: [owner],
      projectId: project.id,
      type: 'pipeline_wedge',
      title: 'A runner can no longer authenticate',
      resolutionKey: 'wedge:runner-1',
    });
    const [row] = (await inbox()).items as [Row];
    expect(row.title).toBe('A runner can no longer authenticate');
    expect(row.projectSlug).toBe(project.slug);
  });
});

describe('unread is state, not text', () => {
  async function dbRead(deliveryId: string): Promise<Date | null> {
    const [r] = (await harness.db.execute(
      sql`SELECT read_at FROM notification_deliveries WHERE id = ${deliveryId}`,
    )) as unknown as { read_at: Date | null }[];
    return r?.read_at ?? null;
  }

  it('takes a delivery out of the unread set once every record it carries has resolved, and the resolved notice with it', async () => {
    const issueId = await seedShipped(50, 'Repair invoice export');
    await mods.recordAndDeliver({
      recipients: [owner],
      projectId: project.id,
      issueId,
      type: 'pipeline_wedge',
      title: 'ISS-50 is wedged',
      resolutionKey: 'wedge:50',
    });
    const before = (await inbox()).items;
    expect(before).toHaveLength(1);
    expect(before[0]?.unread).toBe(true);

    await mods.resolveNotifications('wedge:50');

    const after = (await inbox()).items;
    expect(after).toHaveLength(2);
    const notice = after.find((r) => r.resolvedNotice) as Row;
    const original = after.find((r) => !r.resolvedNotice) as Row;
    expect(notice.unread).toBe(false);
    expect(original.unread).toBe(false);
    // Nothing wrote a read stamp for a person who has not looked: it is derived.
    expect(await dbRead(original.id)).toBeNull();
    expect(await dbRead(notice.id)).toBeNull();
  });

  it('keeps a delivery holding a still-true record unread until a person reads it', async () => {
    await mods.recordAndDeliver({
      recipients: [owner],
      projectId: project.id,
      type: 'pipeline_wedge',
      title: 'A step is held',
      resolutionKey: 'wedge:held',
    });
    const [row] = (await inbox()).items as [Row];
    expect(row.unread).toBe(true);
    await markRead(row.id);
    const [read] = (await inbox()).items as [Row];
    expect(read.unread).toBe(false);
  });

  it('keeps an event unread until it is read, since an event cannot resolve', async () => {
    await mods.recordAndDeliver({
      recipients: [owner],
      projectId: project.id,
      type: 'issue_status_changed',
      title: 'ISS-1 moved to closed',
    });
    const [row] = (await inbox()).items as [Row];
    expect(row.unread).toBe(true);
    await markRead(row.id);
    expect(((await inbox()).items[0] as Row).unread).toBe(false);
  });
});

describe('the list filters before it paginates', () => {
  async function seedMixed() {
    for (let i = 0; i < 5; i += 1) {
      await mods.recordAndDeliver({
        recipients: [owner],
        projectId: project.id,
        type: 'pipeline_wedge',
        title: `Wedge ${i}`,
        resolutionKey: `wedge:mixed-${i}`,
      });
    }
    for (let i = 0; i < 3; i += 1) {
      await mods.recordAndDeliver({
        recipients: [owner],
        projectId: project.id,
        type: 'ops_alert',
        title: `Ops ${i}`,
        resolutionKey: `ops:mixed-${i}`,
      });
    }
    for (let i = 0; i < 2; i += 1) {
      await mods.recordAndDeliver({
        recipients: [owner],
        projectId: project.id,
        type: 'issue_status_changed',
        title: `Moved ${i}`,
      });
    }
    const wedges = (await inbox('?type=pipeline_wedge')).items;
    await markRead((wedges[0] as Row).id);
    await markRead((wedges[1] as Row).id);
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

  it('refuses a type nothing writes, by name', async () => {
    const res = await app.request('/api/notifications?type=comment_added', { headers: auth() });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('type');
  });
});

describe('a delivery written before this change', () => {
  it('is listed under its record’s own title with its stored body, and is not rewritten', async () => {
    const issueId = await seedShipped(9, 'Repair invoice export');
    const legacyBody =
      'Its code has carried a merge mark for 3 days while the issue still reads `waiting`, and nothing is running on it. The step that owed the close did not write it.';
    const [rec] = (await harness.db.execute(sql`
      INSERT INTO notifications (project_id, type, kind, tier, state, title, body, resolution_key, issue_id, group_key, pending_since, last_seen_at)
      VALUES (${project.id}, 'issue_stranded', 'condition', 'ticket', 'firing',
              'ISS-9 shipped but never closed — Invoicing', ${legacyBody},
              ${`issue:${issueId}:owed-close`}, ${issueId}, 'sweep:owed-close:29866100', now(), now())
      RETURNING id
    `)) as unknown as { id: string }[];
    const [del] = (await harness.db.execute(sql`
      INSERT INTO notification_deliveries (user_id, channel, group_key, title)
      VALUES (${owner}, 'bell', 'sweep:owed-close:29866100', ${OWED_CLOSE_CAUSE})
      RETURNING id
    `)) as unknown as { id: string }[];
    await harness.db.execute(sql`
      INSERT INTO notification_delivery_members (delivery_id, notification_id)
      VALUES (${(del as { id: string }).id}, ${(rec as { id: string }).id})
    `);

    const snapshot = async () =>
      JSON.stringify([
        await harness.db.execute(sql`SELECT * FROM notifications ORDER BY id`),
        await harness.db.execute(sql`SELECT * FROM notification_deliveries ORDER BY id`),
        await harness.db.execute(sql`SELECT * FROM notification_delivery_members ORDER BY 1, 2`),
      ]);
    const before = await snapshot();

    const [row] = (await inbox()).items as [Row];
    expect(row.title).toBe('ISS-9 shipped but never closed — Invoicing');
    expect(row.body).toBe(legacyBody);
    expect(row.issueId).toBe(issueId);
    expect(await snapshot()).toBe(before);
  });
});
