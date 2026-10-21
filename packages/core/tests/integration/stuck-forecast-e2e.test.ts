// REQ-48 BC-8, the judges' verdict on dev.270: the Dashboard's forecast put REQ-45 landing today
// while its standing read Stuck. A requirement or feedback item that reads stuck never forecasts a
// landing: its forecast waits on what its standing names, with the stuck reason, so "Lands this week"
// leaves it out and At risk lists it with that reason, both reading the one standing.
//
// @direct-test-of packages/core/src/forecast/scope.ts
// @direct-test-of packages/core/src/forecast/feedback.ts

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, type Body } from '../helpers/api.js';
import {
  DAY,
  feedback,
  issue,
  landHistory,
  read,
  requirement,
  type World,
  world,
} from '../helpers/forecast-world.js';

let w: World;
let req: { id: string; key: string };
let carrier: { id: string; key: string };
let fb = '';

const get = async (path: string): Promise<Body> => {
  const res = await api(w.token, 'GET', `/api/projects/${w.projectId}${path}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};

beforeAll(async () => {
  w = await world();
  await landHistory(w, 12);
  req = await requirement(w, 'A saved board keeps its cards');
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`);
    await tx.execute(sql`
      INSERT INTO requirement_revisions (requirement_id, revision, state, spec, reason, author_id, author_agency, decided_by, decided_at)
      VALUES (${req.id}, 1, 'current', '{"goal":"keep the cards"}'::jsonb, 'seed', ${w.userId}, 'human', ${w.userId}, now())`);
    await tx.execute(
      sql`UPDATE requirements SET status = 'agreed', current_revision = 1 WHERE id = ${req.id}`,
    );
  });
  // its one issue was sent back three weeks ago and nothing has moved it since
  carrier = await issue(w, { status: 'reopen', createdAt: new Date(Date.now() - 21 * DAY) });
  await db.execute(
    sql`UPDATE issues SET requirement_id = ${req.id}, updated_at = now() - interval '21 days' WHERE id = ${carrier.id}`,
  );
  fb = await feedback(w, [carrier.id]);
}, 120_000);

describe('a stuck item never forecasts a landing (REQ-48 BC-8)', () => {
  it("forecasts a stuck requirement as the wait its standing names, with the standing's reason", async () => {
    const standing = (await get(`/requirements/${req.key}`)).standing as Body;
    const times = standing.times as { stuck: { reason: string } | null };
    expect(times.stuck, JSON.stringify(standing)).not.toBeNull();
    const reason = times.stuck?.reason;
    const forecasts = (await read(w, '/requirements')).requirements as Body[];
    const mine = forecasts.find((f) => f.key === req.key);
    expect(mine?.forecast).toMatchObject({ kind: 'paused', reason });
    expect(((mine?.delivery as Body).landing as Body).kind).not.toBe('forecast');
    const one = await read(w, `/requirements/${req.key}`);
    expect(one.forecast).toMatchObject({ kind: 'paused', reason });
  });

  it('forecasts a stuck feedback item the same way, never with a landing date', async () => {
    const item = (await get(`/feedback/${fb}`)).feedback as Body;
    const times = item.times as { stuck: { reason: string } | null };
    expect(times.stuck, JSON.stringify(times)).not.toBeNull();
    const lines = (await read(w, '/feedback')).items as Body[];
    const line = lines.find((l) => l.key === fb);
    expect((line?.delivery as Body).landing).toMatchObject({
      kind: 'paused',
      reason: times.stuck?.reason,
    });
  });
});
