import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { SupportWorld } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/actions-route.ts
// @direct-test-of packages/core/src/support/read.ts
// @direct-test-of packages/core/src/support/store.ts

const w = new SupportWorld();
let roomId = '';

beforeAll(async () => {
  await w.start();
  await w.bind();
  roomId = String((await w.rooms())[0]?.id);
}, 120_000);

afterAll(() => w.stop());

describe("ISS-1215: a room's actions read reaches the newest actions and a window", () => {
  // FB-620: past 500 actions the read stopped at a room's oldest 500, so a daily review reached
  // nothing from its own day, and nothing said the list was cut.
  it("reads a room's newest actions in a window, saying when the limit cut it (ISS-1215)", async () => {
    const base = Date.parse('2030-01-01T00:00:00Z');
    const at = (i: number) => new Date(base + i * 1000).toISOString();
    await db.execute(sql`
      INSERT INTO support_actions (room_id, project_id, thread, kind, actor_kind, actor_key, created_at)
      SELECT ${roomId}::uuid, ${w.projectId}::uuid, 'iss1215', 'message_in', 'member', 'member-1',
             ${at(0)}::timestamptz + make_interval(secs => i)
        FROM generate_series(0, 500) AS i`);
    const path = `/api/projects/${w.projectId}/support/rooms/${roomId}/actions`;

    const all = await api(w.owner, 'GET', path);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    const read = all.body as { actions: { at: string }[]; truncated: boolean };
    expect(read.actions).toHaveLength(500);
    expect(read.actions.at(-1)?.at).toBe(at(500));
    expect(read.truncated).toBe(true);

    const day = await api(w.owner, 'GET', `${path}?since=${at(250)}&until=${at(260)}`);
    expect(day.status, JSON.stringify(day.body)).toBe(200);
    const window = day.body as { actions: { at: string; thread: string }[]; truncated: boolean };
    expect(window.actions.map((a) => a.at)).toEqual(
      Array.from({ length: 10 }, (_, i) => at(250 + i)),
    );
    expect(window.truncated).toBe(false);

    const malformed = await api(w.owner, 'GET', `${path}?since=yesterday`);
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(malformed.body)).toContain('/since');
    const backwards = await api(w.owner, 'GET', `${path}?since=${at(260)}&until=${at(250)}`);
    expect(backwards.status).toBe(400);
    expect(JSON.stringify(backwards.body)).toContain('`until` must come after `since`');
  });
});
