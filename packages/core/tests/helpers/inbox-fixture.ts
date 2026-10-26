/**
 * The inbox harness the notification-list suites share: a database, the notification routes, one
 * signed-in owner and one project, reset before every case. Two suites carrying two copies of it is
 * how one drifts from the other and they stop proving the same thing about the same rows.
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import { type SetupOptions, setupTestDatabase, type TestDatabase } from './db.js';
import { createTestProject, createTestUser } from './factories.js';
import { truncateAll } from './truncate.js';

export type InboxMods = {
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

export type InboxRow = {
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
  toldAt: string;
};
export type InboxPage = { items: InboxRow[]; total: number; hasMore: boolean };
export type InboxMember = {
  id: string;
  title: string;
  body: string | null;
  issueId: string | null;
  projectSlug: string | null;
  open: boolean;
  deliveredAt: string;
};

const HOUR = 60 * 60 * 1000;

export interface InboxFixture {
  readonly db: TestDatabase['db'];
  readonly mods: InboxMods;
  readonly app: Hono<{ Variables: RequestIdVars }>;
  readonly owner: string;
  readonly project: { id: string; slug: string; name: string };
  auth(): { authorization: string };
  inbox(query?: string): Promise<InboxPage>;
  membersOf(deliveryId: string): Promise<InboxMember[]>;
  markRead(deliveryId: string): Promise<Response>;
  /** A merged issue parked under a live status with nothing running: what the owed-close sweep reads. */
  seedShipped(seq: number, title: string): Promise<string>;
  /** Run a detector until it tells somebody: a stranded condition waits two evaluations. */
  announce(
    detect: () => Promise<{ detected: number; notified: number }>,
  ): Promise<{ detected: number; notified: number }>;
  sweepRows(page: InboxPage): InboxRow[];
}

/** Register the suite's hooks and hand back a fixture whose fields follow each `beforeEach`. */
export function registerInboxFixture(setup: SetupOptions = {}): InboxFixture {
  let harness: TestDatabase;
  let mods: InboxMods;
  let app: Hono<{ Variables: RequestIdVars }>;
  let owner = '';
  let project: { id: string; slug: string; name: string };
  let token = '';

  beforeAll(async () => {
    harness = await setupTestDatabase(setup);
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
    app = new Hono<{ Variables: RequestIdVars }>();
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

  return {
    get db() {
      return harness.db;
    },
    get mods() {
      return mods;
    },
    get app() {
      return app;
    },
    get owner() {
      return owner;
    },
    get project() {
      return project;
    },
    auth,
    async inbox(query = '') {
      const res = await app.request(`/api/notifications${query}`, { headers: auth() });
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as InboxPage;
      return { items: body.items, total: body.total, hasMore: body.hasMore };
    },
    async membersOf(deliveryId) {
      const res = await app.request(`/api/notifications/${deliveryId}/members`, {
        headers: auth(),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      return (await res.json()) as InboxMember[];
    },
    async markRead(deliveryId) {
      return app.request(`/api/notifications/${deliveryId}`, {
        method: 'PATCH',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ read: true }),
      });
    },
    async seedShipped(seq, title) {
      const id = crypto.randomUUID();
      const longAgo = new Date(Date.now() - 48 * HOUR).toISOString();
      await harness.db.execute(sql`
        INSERT INTO issues (id, project_id, title, status, created_by_id, merged_at, iss_seq, updated_at)
        VALUES (${id}, ${project.id}, ${title}, 'waiting', ${owner}, ${longAgo}, ${seq}, ${longAgo})
      `);
      return id;
    },
    async announce(detect) {
      await detect();
      await harness.db.execute(
        sql`UPDATE notifications SET pending_since = now() - interval '10 minutes'`,
      );
      return detect();
    },
    sweepRows: (page) => page.items.filter((r) => r.type === 'issue_stranded'),
  };
}
