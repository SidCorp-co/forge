/**
 * ISS-1025 — `GET /api/skill-activity` is bounded, and says so.
 *
 * Its own file rather than a second `describe` in `skill-activity-routes.test.ts`:
 * `setupTestDatabase()` twice in one file leaves the db client pointed at
 * whichever harness booted first, so the second block's seed rows land in a
 * database the route never reads.
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

/**
 * ISS-1025 — the three §7 views were unbounded reads of
 * `skill_activity_events`: a project that has been reconciling for months
 * answered `GET /api/skill-activity` with its whole log. The cap is the
 * behaviour under test, and so is what the response says about it.
 */
const ADMIN_EMAIL = 'bounded-activity@test.forge.local';

describe('GET /api/skill-activity is bounded, and says so', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  let createTestProject: typeof import('../helpers/index.js').createTestProject;
  let createTestProjectMember: typeof import('../helpers/index.js').createTestProjectMember;
  let projectId: string;
  let token: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;

    const helpers = await import('../helpers/index.js');
    createTestProject = helpers.createTestProject;
    createTestProjectMember = helpers.createTestProjectMember;

    const { skillActivityRoutes } = await import('../../src/skills/activity-routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/skill-activity', skillActivityRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  /**
   * `n` events for one project, one second apart, oldest first. The user is on
   * the admin allow-list as well as a project member, because the by-packet
   * view is admin-only and shares this harness.
   */
  async function seedEvents(n: number) {
    await truncateAll(harness.db);
    const user = await createTestUser(harness.db, { email: ADMIN_EMAIL });
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, { userId: user.id, projectId: project.id });
    projectId = project.id;
    token = await signUserToken(user.id);

    for (let i = 0; i < n; i += 1) {
      await harness.db.execute(sql`
        INSERT INTO skill_activity_events
          (project_id, event_type, actor, trigger, outcome, occurred_at, reason)
        VALUES (${projectId}, 'skill.body.changed', 'agent:test', 'poll', 'ok',
                ${new Date(1_800_000_000_000 + i * 1000).toISOString()}, ${`e${i}`})
      `);
    }
  }

  /** `n` events under `packetId`, one second apart. */
  async function seedPacket(packetId: string, n: number, eventType = 'device.skill.applied') {
    for (let i = 0; i < n; i += 1) {
      await harness.db.execute(sql`
        INSERT INTO skill_activity_events
          (packet_id, event_type, actor, trigger, outcome, occurred_at, reason)
        VALUES (${packetId}, ${eventType}, 'agent:test', 'poll', 'ok',
                ${new Date(1_800_000_000_000 + i * 1000).toISOString()}, ${`p${i}`})
      `);
    }
  }

  const get = async (query: string) =>
    app.request(`/api/skill-activity?${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });

  it('reports truncated:false for a page holding exactly the limit', async () => {
    await seedEvents(3);
    const res = await get(`projectId=${projectId}&limit=3`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; limit: number; truncated: boolean };
    expect(body.events).toHaveLength(3);
    expect(body.limit).toBe(3);
    expect(body.truncated).toBe(false);
  });

  it('reports truncated:true for one event more than the limit', async () => {
    await seedEvents(4);
    const res = await get(`projectId=${projectId}&limit=3`);
    const body = (await res.json()) as { events: unknown[]; truncated: boolean };
    expect(body.events).toHaveLength(3);
    expect(body.truncated).toBe(true);
  });

  it('keeps the most recent events when the limit cuts, still oldest-first', async () => {
    await seedEvents(5);
    const res = await get(`projectId=${projectId}&limit=2`);
    const body = (await res.json()) as { events: Array<{ reason: string }> };
    expect(body.events.map((e) => e.reason)).toEqual(['e3', 'e4']);
  });

  it('lists an uncut page oldest-first', async () => {
    await seedEvents(3);
    const res = await get(`projectId=${projectId}`);
    const body = (await res.json()) as { events: Array<{ reason: string }> };
    expect(body.events.map((e) => e.reason)).toEqual(['e0', 'e1', 'e2']);
  });

  it('applies the default limit of 200 when the caller sends none', async () => {
    await seedEvents(1);
    const res = await get(`projectId=${projectId}`);
    const body = (await res.json()) as { limit: number; truncated: boolean };
    expect(body.limit).toBe(200);
    expect(body.truncated).toBe(false);
  });

  it('refuses a limit above the maximum rather than serving a quietly smaller page', async () => {
    await seedEvents(1);
    const res = await get(`projectId=${projectId}&limit=1001`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/1000/);
  });

  it('serves the maximum itself', async () => {
    await seedEvents(1);
    const res = await get(`projectId=${projectId}&limit=1000`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { limit: number }).limit).toBe(1000);
  });

  it('refuses a limit of zero', async () => {
    await seedEvents(1);
    expect((await get(`projectId=${projectId}&limit=0`)).status).toBe(400);
  });

  /**
   * ISS-1025 review, F1 — the by-packet rollup counts the PACKET, not the page.
   * `summary` is an operational figure ("N no-op / M changed / K escalated")
   * that predates the cap, so summing the returned events would have turned it
   * into a count of whatever fitted under the limit — silently, and on exactly
   * the packets big enough for an operator to be reading the rollup for.
   */
  it('summarises every event in the packet while returning only the page', async () => {
    await seedEvents(1);
    await seedPacket('P-rollup', 3);
    await seedPacket('P-other', 4, 'skill.body.changed');
    const res = await get('packetId=P-rollup&limit=2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: unknown[];
      truncated: boolean;
      summary: Record<string, number>;
    };
    expect(body.events).toHaveLength(2);
    expect(body.truncated).toBe(true);
    expect(body.summary).toEqual({ 'device.skill.applied': 3 });
  });
});
