import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, type Body } from '../helpers/api.js';
import { ago, issue, moved, type World, world } from '../helpers/forecast-world.js';

// The Issues band's one chart (REQ-43 r3 BC-16): issues filed and closed per day in the reader's
// zone. Filed counts what the list counts, so an archived issue is not filed; closed counts a move
// into a terminal status once per issue per day, so a close, reopen and close again is one close.
// @direct-test-of packages/core/src/issues/flow-read.ts
// @direct-test-of packages/core/src/issues/standing-routes.ts

describe('the issue flow read', () => {
  let w: World;
  let flow: Body;

  beforeAll(async () => {
    w = await world();
    const now = new Date();
    const closedTwice = await issue(w, { status: 'closed', createdAt: ago(1), mergedAt: ago(0.5) });
    await moved(w, closedTwice.id, 'in_progress', 'closed', ago(0.05));
    await moved(w, closedTwice.id, 'closed', 'reopen', ago(0.04));
    await moved(w, closedTwice.id, 'reopen', 'closed', ago(0.03));
    const dropped = await issue(w, { status: 'dropped', createdAt: ago(1) });
    await moved(w, dropped.id, 'open', 'dropped', ago(0.2));
    await issue(w, { status: 'open', createdAt: ago(1) });
    const archived = await issue(w, { status: 'open', createdAt: ago(1) });
    await db.execute(sql`UPDATE issues SET archived_at = now() WHERE id = ${archived.id}`);
    // filed before the window: it never reaches a day of it
    await issue(w, { status: 'open', createdAt: ago(24 * 20) });
    const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/issues/flow?tz=UTC`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    flow = res.body;
    expect(flow.days.at(-1).day).toBe(now.toISOString().slice(0, 10));
  });

  it('counts the issues the list counts as filed, and each close once per issue per day', () => {
    const total = (k: 'opened' | 'closed') =>
      (flow.days as { opened: number; closed: number }[]).reduce((n, d) => n + d[k], 0);
    expect(flow.days).toHaveLength(14);
    expect(total('opened')).toBe(3);
    expect(total('closed')).toBe(2);
  });

  it('refuses a zone it cannot count a day in, by name', async () => {
    const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/issues/flow?tz=Mars/Base`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Mars/Base');
  });
});
