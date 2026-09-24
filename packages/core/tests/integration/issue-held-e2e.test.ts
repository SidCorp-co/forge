import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import { createTestProjectMember } from '../helpers/factories.js';
import { registerIdleFixture, testLease } from '../helpers/idle-fixture.js';

/**
 * ISS-1213 — whether anything is on an issue, against a live database.
 *
 * The lane reads `running` only on a row this answers `true` for, so each term that may hold a row
 * is seeded alone and must hold it, and each shape that must NOT hold one is seeded with no work in
 * flight beside it. The two mixed cases pin the OR: a lapsed or shared claim does not unhold a row
 * a live job is on.
 */
const fx = registerIdleFixture(1600);
const NOW = new Date('2026-09-20T16:00:00.000Z');

async function held(issueId: string): Promise<boolean | undefined> {
  const { hydrateHeldForIssues } = await import('../../src/issues/held-hydrator.js');
  return (await hydrateHeldForIssues([issueId], NOW)).get(issueId);
}

const claimed = (over: Record<string, unknown> = {}) =>
  fx.seedIssue({ status: 'testing', sessionContext: { lease: testLease(over) } });

describe('hydrateHeldForIssues — what holds a row (ISS-1213)', () => {
  it('holds nothing on a `testing` row with nothing on it: the measured eleven', async () => {
    expect(await held(await fx.seedIssue({ status: 'testing' }))).toBe(false);
  });

  it('holds a row a live job is on', async () => {
    const id = await fx.seedIssue({ status: 'testing' });
    const runId = await fx.seedLiveJob(id);
    await fx.db.execute(sql`UPDATE pipeline_runs SET status='completed' WHERE id=${runId}`);
    expect(await held(id)).toBe(true);
  });

  it('holds a row a live pipeline run is on', async () => {
    const id = await fx.seedIssue({ status: 'developed' });
    await fx.seedRun(id, 'running');
    expect(await held(id)).toBe(true);
  });

  it('holds a row whose fleet-wide issue lease has a live session', async () => {
    const id = await fx.seedIssue({ status: 'in_progress' });
    await fx.seedIssueLease(fx.lastSeq, 'running');
    expect(await held(id)).toBe(true);
  });

  it('holds a row carrying an unexpired claim whose holder is on nothing else', async () => {
    expect(await held(await claimed())).toBe(true);
  });
});

describe('hydrateHeldForIssues — what does not (ISS-1213)', () => {
  it('does not hold a row whose claim has run past its expiry', async () => {
    expect(await held(await claimed({ renewedAt: '2026-09-20T14:00:00.000Z' }))).toBe(false);
  });

  it('does not hold a row whose claim was released', async () => {
    expect(await held(await claimed({ stopped: '2026-09-20T15:50:00.000Z' }))).toBe(false);
  });

  it('does not hold either row when one holder id claims two at once', async () => {
    const a = await claimed({ holder: 'shared-holder' });
    const b = await claimed({ holder: 'shared-holder' });
    expect([await held(a), await held(b)]).toEqual([false, false]);
  });

  it('does not hold a row whose issue lease session has gone terminal', async () => {
    const id = await fx.seedIssue({ status: 'in_progress' });
    await fx.seedIssueLease(fx.lastSeq, 'completed');
    expect(await held(id)).toBe(false);
  });

  it('answers only for the ids it was asked about', async () => {
    const { hydrateHeldForIssues } = await import('../../src/issues/held-hydrator.js');
    await fx.seedIssue({ status: 'testing' });
    expect((await hydrateHeldForIssues([], NOW)).size).toBe(0);
  });
});

describe('hydrateHeldForIssues — a lapsed claim does not unhold live work (ISS-1213)', () => {
  it('holds a row a live run is on though its claim expired', async () => {
    const id = await claimed({ renewedAt: '2026-09-20T14:00:00.000Z' });
    await fx.seedRun(id, 'running');
    expect(await held(id)).toBe(true);
  });

  it('holds a row a live run is on though its claim is shared', async () => {
    const id = await claimed({ holder: 'shared-holder' });
    await claimed({ holder: 'shared-holder' });
    await fx.seedRun(id, 'running');
    expect(await held(id)).toBe(true);
  });
});

describe('GET /issues/search?withAgentSessions returns `held` on every row (ISS-1213)', () => {
  it('reads true on the row a run is on and false on the row nothing is on', async () => {
    const heldId = await fx.seedIssue({ status: 'testing' });
    await fx.seedRun(heldId, 'running');
    const idleId = await fx.seedIssue({ status: 'testing' });

    await fx.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${fx.ownerId}::uuid`,
    );
    await createTestProjectMember(fx.db, {
      userId: fx.ownerId,
      projectId: fx.projectId,
      role: 'admin',
    });
    const { searchRoutes } = await import('../../src/issues/search.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    const { signUserToken } = await import('../../src/auth/jwt.js');
    const app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/projects', searchRoutes);
    app.onError(errorHandler);

    const res = await app.request(
      `/api/projects/${fx.projectId}/issues/search?withAgentSessions=true`,
      { headers: { Authorization: `Bearer ${await signUserToken(fx.ownerId)}` } },
    );
    expect(res.status).toBe(200);
    const items = ((await res.json()) as { items: { id: string; held?: unknown }[] }).items;
    expect(items.map((i) => typeof i.held)).toEqual(['boolean', 'boolean']);
    const byId = new Map(items.map((i) => [i.id, i.held]));
    expect([byId.get(heldId), byId.get(idleId)]).toEqual([true, false]);
  });
});
