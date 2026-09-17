/**
 * ISS-1063 — the gates between a record and a person, one case per way they leaked.
 *
 * Every case here is a defect a review of this branch found, planted and watched go red
 * before the fix: the four primitives are about who is told, and each of them was either
 * applied to the wrong person or applied on one path and walked around on another.
 *
 * It lives beside `notification-record-kinds-e2e.test.ts` rather than inside it because
 * that file is at its line budget, and because these are a different question. That one
 * asks what the model IS; this one asks whether the gates hold on every path into it.
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
  deliverExisting: typeof import('../../src/notifications/deliver.js').deliverExisting;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  hooks: typeof import('../../src/pipeline/hooks.js').hooks;
};

let harness: TestDatabase;
let mods: Mods;
let app: Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>;
let alice: string;
let bob: string;
let projectId: string;
let tokens: Record<string, string>;

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
  const { hooks } = await import('../../src/pipeline/hooks.js');
  mods = {
    recordAndDeliver: deliver.recordAndDeliver,
    deliverExisting: deliver.deliverExisting,
    hooks,
  };

  const { notificationRoutes } = await import('../../src/notifications/routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{
    Variables: import('../../src/middleware/request-id.js').RequestIdVars;
  }>();
  app.use('*', requestId());
  app.route('/api/notifications', notificationRoutes);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  alice = (await createTestUser(harness.db)).id;
  bob = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  projectId = (await createTestProject(harness.db, alice)).id;
  const { signUserToken } = await import('../../src/auth/jwt.js');
  tokens = { [alice]: await signUserToken(alice), [bob]: await signUserToken(bob) };
});

/** Every bell row this reader holds. */
async function bellOf(userId: string): Promise<{ id: string; title: string }[]> {
  const res = await app.request('/api/notifications', {
    headers: { authorization: `Bearer ${tokens[userId]}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: { id: string; title: string }[] }).items;
}

function deleteDelivery(userId: string, deliveryId: string) {
  return app.request(`/api/notifications/${deliveryId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${tokens[userId]}` },
  });
}

async function silence(userId: string, body: Record<string, unknown>): Promise<void> {
  const res = await app.request('/api/notifications/silences', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[userId]}` },
    body: JSON.stringify({
      reason: 'working on it',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      ...body,
    }),
  });
  expect(res.status).toBe(201);
}

function wedge(key: string, recipients: string[]) {
  return mods.recordAndDeliver({
    recipients,
    projectId,
    type: 'pipeline_wedge',
    title: 'the pipeline is wedged',
    resolutionKey: key,
  });
}

/** A condition that waits for a second evaluation, emitted `times` times. */
async function strand(key: string, recipients: string[], times: number, groupKey?: string) {
  let last: Awaited<ReturnType<typeof mods.recordAndDeliver>> = null;
  for (let i = 0; i < times; i += 1) {
    last = await mods.recordAndDeliver({
      recipients,
      projectId,
      type: 'issue_stranded',
      title: `${key} is parked`,
      resolutionKey: key,
      ...(groupKey ? { groupKey, groupTitle: 'issues are parked with merged code' } : {}),
    });
  }
  return last;
}

/** Age every pending record past its `for` duration, as three sweeps would. */
function ripen(): Promise<unknown> {
  return harness.db.execute(
    sql`UPDATE notifications SET pending_since = now() - interval '10 minutes'`,
  );
}

describe('notifications · a silence is one reader’s, not a switch', () => {
  it('silences the reader who set it and nobody else', async () => {
    await silence(alice, { type: 'pipeline_wedge', projectId });
    await wedge('wedge:a', [alice, bob]);

    expect(await bellOf(alice)).toEqual([]);
    expect(await bellOf(bob)).toHaveLength(1);
  });

  it('with no matchers at all, still silences only its author', async () => {
    await silence(alice, {});
    await wedge('wedge:a', [alice, bob]);

    expect(await bellOf(alice)).toEqual([]);
    expect(await bellOf(bob)).toHaveLength(1);
  });

  it('a condition first recorded under a silence reaches the reader once it expires', async () => {
    await silence(alice, { type: 'pipeline_wedge', projectId });
    const first = await wedge('wedge:a', [alice]);
    expect(first?.delivered).toBe(0);

    await harness.db.execute(
      sql`UPDATE notification_silences SET expires_at = now() - interval '1 minute'`,
    );
    // The SAME identity, re-emitted by the next sweep: one record, and the delivery the
    // silence held back. Returning early on "this record already exists" left a condition
    // that is still true undelivered for as long as it lasted.
    const again = await wedge('wedge:a', [alice]);
    expect(again?.id).toBe(first?.id);
    expect(again?.delivered).toBe(1);
    expect(await bellOf(alice)).toHaveLength(1);
  });

  it('a pending condition maturing under a silence delivers nothing', async () => {
    await silence(alice, { type: 'issue_stranded', projectId });
    await strand('stranded:1', [alice], 2);
    await ripen();
    const promoted = await strand('stranded:1', [alice], 1);

    expect(promoted?.delivered).toBe(0);
    expect(await bellOf(alice)).toEqual([]);
    const [{ state }] = (await harness.db.execute(
      sql`SELECT state FROM notifications WHERE resolution_key = 'stranded:1'`,
    )) as unknown as [{ state: string }];
    // Promoted: the condition IS firing. What the silence held back is the telling.
    expect(state).toBe('firing');
  });

  it('a record delivered later, by its own producer, is silenced too', async () => {
    await silence(bob, { type: 'ops_alert' });
    const record = await mods.recordAndDeliver({
      recipients: [],
      projectId,
      type: 'ops_alert',
      title: 'the runner pool is empty',
      resolutionKey: 'ops:pool-empty',
    });
    const told = await mods.deliverExisting(record?.id ?? '', [alice, bob]);

    expect(told).toBe(1);
    expect(await bellOf(bob)).toEqual([]);
    expect(await bellOf(alice)).toHaveLength(1);
  });
});

describe('notifications · a condition maturing into a live cause is that cause’s child', () => {
  it('a pending strand promoting under a firing wedge is inhibited, not delivered', async () => {
    await strand('stranded:1', [alice], 2);
    await ripen();
    // The wedge starts firing between the strand's first sighting and its promotion.
    await wedge('wedge:root', [alice]);
    const promoted = await strand('stranded:1', [alice], 1);

    expect(promoted?.delivered).toBe(0);
    const [{ state }] = (await harness.db.execute(
      sql`SELECT state FROM notifications WHERE resolution_key = 'stranded:1'`,
    )) as unknown as [{ state: string }];
    expect(state).toBe('inhibited');
    expect((await bellOf(alice)).map((r) => r.title)).toEqual(['the pipeline is wedged']);
  });
});

describe('notifications · the mention opt-out survived the split', () => {
  it('a user who turned mentions off gets the record but no delivery', async () => {
    await harness.db.execute(
      sql`INSERT INTO user_preferences (user_id, notify_on_mention) VALUES (${bob}, false)`,
    );
    const result = await mods.recordAndDeliver({
      recipients: [alice, bob],
      projectId,
      type: 'mention',
      title: 'alice mentioned you',
    });

    // One record: what happened is not one reader's to suppress. One delivery.
    expect(result?.delivered).toBe(1);
    expect(await bellOf(bob)).toEqual([]);
    expect(await bellOf(alice)).toHaveLength(1);
  });
});

describe('notifications · grouping quiets the channel that interrupts', () => {
  it('fifteen records in one grouped delivery announce once', async () => {
    const announced: boolean[] = [];
    const off = mods.hooks.on('notificationCreated', (p) => {
      if (p.userId === alice) announced.push(p.announce !== false);
    });
    try {
      for (let i = 0; i < 15; i += 1) await strand(`stranded:${i}`, [alice], 2, 'sweep:1');
      await ripen();
      for (let i = 0; i < 15; i += 1) await strand(`stranded:${i}`, [alice], 1, 'sweep:1');
    } finally {
      off();
    }

    // Fifteen events, because fifteen records did reach her and the bell must refresh for
    // each. ONE of them may interrupt: the toast, the sound and the browser notification
    // are what "the owner was told fifteen times" meant.
    expect(announced).toHaveLength(15);
    expect(announced.filter(Boolean)).toHaveLength(1);
    expect(await bellOf(alice)).toHaveLength(1);
  });

  it('an ungrouped record still announces, one per reader', async () => {
    const announced: string[] = [];
    const off = mods.hooks.on('notificationCreated', (p) => {
      if (p.announce !== false) announced.push(p.userId);
    });
    try {
      await wedge('wedge:a', [alice, bob]);
    } finally {
      off();
    }
    expect(announced.sort()).toEqual([alice, bob].sort());
  });
});

describe('notifications · a receipt for a condition that is still true is not deletable', () => {
  it('refuses the delete, names the condition, and points at silences', async () => {
    await wedge('wedge:a', [alice]);
    const [row] = await bellOf(alice);

    const res = await deleteDelivery(alice, row?.id ?? '');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message?: string; error?: string };
    const message = body.message ?? body.error ?? '';
    expect(message).toContain('the pipeline is wedged');
    expect(message).toContain('/api/notifications/silences');
    expect(await bellOf(alice)).toHaveLength(1);
  });

  // cm:guard this is the reason the refusal exists, not a second opinion about it. The
  // delivery is the receipt `deliverTo` reads to decide whether this person has been told:
  // delete one while its condition still fires and the next sweep finds no receipt, writes a
  // second delivery and interrupts again — once a minute, for as long as the condition lasts.
  it('so a reader cannot re-arm a firing condition by deleting it', async () => {
    await wedge('wedge:a', [alice]);
    const [row] = await bellOf(alice);
    expect((await deleteDelivery(alice, row?.id ?? '')).status).toBe(409);

    // The next two sweeps re-emit the same identity, as every periodic producer now does.
    expect((await wedge('wedge:a', [alice]))?.delivered).toBe(0);
    expect((await wedge('wedge:a', [alice]))?.delivered).toBe(0);
    expect(await bellOf(alice)).toHaveLength(1);
  });

  it('allows the delete once the condition has ended', async () => {
    await wedge('wedge:a', [alice]);
    const [row] = await bellOf(alice);
    await harness.db.execute(sql`UPDATE notifications SET state = 'resolved', resolved_at = now()`);

    expect((await deleteDelivery(alice, row?.id ?? '')).status).toBe(204);
    expect(await bellOf(alice)).toEqual([]);
  });

  it('allows the delete of a signal, which was never a condition', async () => {
    await mods.recordAndDeliver({
      recipients: [alice],
      projectId,
      type: 'issue_status_changed',
      title: 'ISS-1 moved to testing',
    });
    const [row] = await bellOf(alice);

    expect((await deleteDelivery(alice, row?.id ?? '')).status).toBe(204);
    expect(await bellOf(alice)).toEqual([]);
  });
});

describe('notifications · a live root cause stops the delivery retry too', () => {
  it('does not tell a newly-reachable reader about a child while its cause fires', async () => {
    await strand('stranded:1', [alice], 2);
    await ripen();
    expect((await strand('stranded:1', [alice], 1))?.delivered).toBe(1);

    // The root starts firing after the child was already delivered to Alice. Bob has not been
    // told, and must not be: inhibition decides who hears about a child, and the retry that
    // catches up a reader gated out earlier is a telling like any other.
    await wedge('wedge:root', [alice, bob]);
    expect((await strand('stranded:1', [alice, bob], 1))?.delivered).toBe(0);
    expect((await bellOf(bob)).map((r) => r.title)).toEqual(['the pipeline is wedged']);

    // …and the child stays FIRING rather than being demoted, because it is still true and the
    // count of what is still true is the number this whole change exists to make honest.
    const [{ state }] = (await harness.db.execute(
      sql`SELECT state FROM notifications WHERE resolution_key = 'stranded:1'`,
    )) as unknown as [{ state: string }];
    expect(state).toBe('firing');
  });
});
