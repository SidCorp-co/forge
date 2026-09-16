/**
 * ISS-879 — `resolveNotifications` against real Postgres.
 *
 * `auto-resolve.ts` carried a `cm:guard` predicting this: the `notificationRead`
 * hook decrements a client-side unread count, so emitting it twice for one row
 * double-counts. It was unreachable while every resolution key had exactly ONE
 * clearer. `paused:<runId>` is the first key with two — the run-left-paused
 * subscriber and the empty-queue sweep — so the read-then-update pair became a
 * real interleaving and collapsed into one locked statement.
 *
 * The unit suite pins the SQL shape against a mocked db. A mock cannot execute
 * `UPDATE ... FROM (SELECT ... FOR UPDATE) ...` or tell whether that statement parses;
 * that is what this file is for. It does NOT witness the interleaving itself — see the
 * guard on the last case.
 *
 * ISS-1063 changed WHAT one clear does, and this file moved with it rather than around it.
 * Resolving no longer marks anything read — read state left the record table — so what is
 * announced once instead of twice is the RESOLVED NOTICE (`notificationCreated` from
 * `sendResolvedNotice`), and a row's read state is now its delivery's. The serialization
 * this file exists to hold is unchanged: two clearers of one key still produce one clear
 * and one announcement, and the `FOR UPDATE` on the sub-SELECT is still the only thing
 * making that true.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
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
  resolveNotifications: typeof import('../../src/notifications/auto-resolve.js').resolveNotifications;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  hooks: typeof import('../../src/pipeline/hooks.js').hooks;
};

describe('resolveNotifications E2E (ISS-879)', () => {
  let harness: TestDatabase;
  let mods: Mods;
  let projectId: string;
  let ownerId: string;
  let emitted: string[];

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

    const autoResolve = await import('../../src/notifications/auto-resolve.js');
    const hooksMod = await import('../../src/pipeline/hooks.js');
    mods = { resolveNotifications: autoResolve.resolveNotifications, hooks: hooksMod.hooks };
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    projectId = (await createTestProject(harness.db, owner.id)).id;
    mods.hooks.reset();
    emitted = [];
    mods.hooks.on('notificationCreated', (p) => {
      emitted.push(p.notificationId);
    });
  });

  /** A firing condition, plus the one delivery that says the owner was told about it. */
  async function insertNotification(key: string, read: boolean): Promise<string> {
    const id = randomUUID();
    const deliveryId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO notifications (id, project_id, type, kind, tier, state, title, body, resolution_key)
      VALUES (${id}, ${projectId}, 'pipeline_wedge', 'condition', 'ticket', 'firing',
              'frozen', 'body', ${key})
    `);
    await harness.db.execute(sql`
      INSERT INTO notification_deliveries (id, user_id, channel, title, read_at)
      VALUES (${deliveryId}, ${ownerId}, 'bell', 'frozen', ${read ? sql`now()` : sql`NULL`})
    `);
    await harness.db.execute(sql`
      INSERT INTO notification_delivery_members (delivery_id, notification_id)
      VALUES (${deliveryId}, ${id})
    `);
    return id;
  }

  // cm:guard read comes off the DELIVERY and resolved off the RECORD, and the pairs below
  // assert that resolving moves only the second. A helper reading both off one row is the
  // conflation ISS-1063 removed, and would make every case here pass for the wrong reason.
  async function row(id: string): Promise<{ read: boolean; resolved: boolean }> {
    const rows = await harness.db.execute<{ read_at: string | null; resolved_at: string | null }>(
      sql`SELECT d.read_at, n.resolved_at
            FROM notifications n
            JOIN notification_delivery_members m ON m.notification_id = n.id
            JOIN notification_deliveries d ON d.id = m.delivery_id
           WHERE n.id = ${id} AND d.resolved_notice = false`,
    );
    return { read: rows[0]?.read_at !== null, resolved: rows[0]?.resolved_at !== null };
  }

  it('stamps an unread row and emits once', async () => {
    const id = await insertNotification('wedge:paused:run-1', false);

    expect(await mods.resolveNotifications('wedge:paused:run-1')).toBe(1);

    expect(emitted).toEqual([id]);
    // ISS-1063 — the clear does NOT mark it read; it was unread before and it stays unread.
    expect(await row(id)).toEqual({ read: false, resolved: true });
  });

  // cm:guard an already-read row must still be STAMPED — `emitPipelineWedge`'s dedupe reads `resolved_at`, so leaving it NULL on the notifications someone actually opened suppresses the next wedge for that entity forever
  it('stamps an already-read row, and still tells the reader it cleared', async () => {
    const id = await insertNotification('wedge:paused:run-2', true);

    expect(await mods.resolveNotifications('wedge:paused:run-2')).toBe(1);

    // ISS-1063 — a resolved notice goes to whoever was delivered the start, opened or not:
    // "you looked at it" and "it is over" are different facts and the second is news.
    expect(emitted).toEqual([id]);
    expect(await row(id)).toEqual({ read: true, resolved: true });
  });

  // cm:guard `Promise.all` over this pool does NOT interleave a SELECT between another call's SELECT and UPDATE, so this case alone passes against the pre-fix shape too — it holds the observable contract and nothing more. The case BELOW is the one that witnesses the defect; do not delete it as a duplicate of this one.
  it('yields exactly one clear and one emit when two clearers run together', async () => {
    const id = await insertNotification('wedge:paused:run-3', false);

    const [a, b] = await Promise.all([
      mods.resolveNotifications('wedge:paused:run-3'),
      mods.resolveNotifications('wedge:paused:run-3'),
    ]);

    expect(a + b).toBe(1);
    expect(emitted).toEqual([id]);
    expect(await row(id)).toEqual({ read: false, resolved: true });
  });

  // cm:why holding the row lock from a third connection is what opens the window a single pooled `Promise.all` never opens — both clearers reach their write while the row is held, so neither can see the other's outcome before starting
  // cm:guard this is the interleaving itself, and it exists because a guard here once claimed the defect could not be witnessed — which is self-fulfilling, since nobody tries again. Forcing it needs two real connections and no new dependency: A holds a row lock, both clearers then race for it. Measured 2026-08-30 without `FOR UPDATE` on the sub-SELECT: both callers claim the row and `notificationRead` fires TWICE for one notification, which is the client-side unread count decremented twice. `paused:<runId>` (ISS-879) is the first resolution key with two independent clearers, which is what made this reachable at all.
  it('emits once, not twice, when two clearers genuinely interleave on one row', async () => {
    const id = await insertNotification('wedge:paused:run-5', false);

    const blocker = new pg.Client({ connectionString: harness.url });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM notifications WHERE id = $1 FOR UPDATE', [id]);

      const racing = Promise.all([
        mods.resolveNotifications('wedge:paused:run-5'),
        mods.resolveNotifications('wedge:paused:run-5'),
      ]);
      await new Promise((r) => setTimeout(r, 300));
      await blocker.query('COMMIT');

      const [a, b] = await racing;
      expect(a + b).toBe(1);
      expect(emitted).toEqual([id]);
    } finally {
      await blocker.end();
    }
  });

  it('clears nothing and emits nothing when the key has no unresolved rows', async () => {
    await insertNotification('wedge:paused:run-4', false);
    await mods.resolveNotifications('wedge:paused:run-4');
    emitted.length = 0;

    expect(await mods.resolveNotifications('wedge:paused:run-4')).toBe(0);
    expect(emitted).toEqual([]);
  });
});
