/**
 * ISS-1229 r14 — the bell's open count once read 23.7s on beta, on a board holding about 4,000
 * standing stuck-issue findings, while the version route read 9.9s in the same probe. This measures
 * the count on its own, on a reader holding 5,000 rows over 5,000 open stuck-issue records beside
 * four other readers holding as many, and prints its plan, so the number says whether the query or
 * the box was slow.
 */

import { writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestUser } from '../helpers/factories.js';
import { registerInboxFixture } from '../helpers/inbox-fixture.js';

const fx = registerInboxFixture();
const ROWS = 5_000;

/** `n` open stuck-issue records, each in a bell row of its own, for one reader. */
async function plant(userId: string, prefix: string, n: number): Promise<void> {
  const id = (kind: string) => sql.raw(`('${prefix}${kind}' || lpad(to_hex(g), 12, '0'))::uuid`);
  await fx.db.execute(sql`
    INSERT INTO notifications (id, project_id, type, kind, tier, state, title, resolution_key)
    SELECT ${id('1-0000-4000-8000-')}, ${fx.project.id}, 'issue_stranded', 'condition', 'ticket', 'firing',
           'stuck ' || g, 'issue:${sql.raw(prefix)}' || g || ':idle'
      FROM generate_series(1, ${n}) g
  `);
  await fx.db.execute(sql`
    INSERT INTO notification_deliveries (id, user_id)
    SELECT ${id('2-0000-4000-8000-')}, ${userId} FROM generate_series(1, ${n}) g
  `);
  await fx.db.execute(sql`
    INSERT INTO notification_delivery_members (delivery_id, notification_id)
    SELECT ${id('2-0000-4000-8000-')}, ${id('1-0000-4000-8000-')} FROM generate_series(1, ${n}) g
  `);
}

describe('the open count on a large inbox', () => {
  it('is answered in under a second for a reader holding 5,000 open rows', async () => {
    await plant(fx.owner, 'a000000', ROWS);
    for (const prefix of ['b000000', 'c000000', 'd000000', 'e000000']) {
      await plant((await createTestUser(fx.db)).id, prefix, ROWS);
    }
    await fx.db.execute(sql`ANALYZE notifications`);
    await fx.db.execute(sql`ANALYZE notification_deliveries`);
    await fx.db.execute(sql`ANALYZE notification_delivery_members`);

    const read = async () => {
      const started = performance.now();
      const res = await fx.app.request('/api/notifications/open-count', { headers: fx.auth() });
      const ms = performance.now() - started;
      expect(res.status).toBe(200);
      return { ms, count: ((await res.json()) as { count: number }).count };
    };
    await read();
    const timings: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { ms, count } = await read();
      expect(count).toBe(ROWS);
      timings.push(ms);
    }
    timings.sort((a, b) => a - b);
    const median = timings[2] ?? Number.POSITIVE_INFINITY;

    const plan = (await fx.db.execute(sql`
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT count(*) FROM notification_deliveries d
       WHERE d.user_id = ${fx.owner} AND NOT d.resolved_notice
         AND EXISTS (
           SELECT 1 FROM notification_delivery_members cb
           JOIN notifications cn ON cn.id = cb.notification_id
           WHERE cb.delivery_id = d.id AND cn.type <> 'invitation_received'
             AND cn.resolved_at IS NULL AND cn.kind = 'condition' AND cn.state = 'firing')
    `)) as unknown as Array<Record<string, string>>;
    const report =
      `[open-count] ${ROWS} rows for the reader, ${ROWS * 4} for others: median ${median.toFixed(1)}ms ` +
      `over ${timings.map((t) => t.toFixed(1)).join(', ')}\n${plan.map((r) => Object.values(r)[0]).join('\n')}\n`;
    // Where a run asks for the figures, they are written out whole: the suite prints no console.
    if (process.env.OPEN_COUNT_REPORT) writeFileSync(process.env.OPEN_COUNT_REPORT, report);
    expect(median).toBeLessThan(1_000);
  }, 120_000);
});
