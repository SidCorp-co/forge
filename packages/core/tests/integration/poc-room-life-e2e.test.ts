import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The preview site, set before the process reads its environment: a development `host:port`.
vi.hoisted(() => {
  process.env.PREVIEW_DOMAIN = 'preview.localhost:7311';
});

import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { sweepPreviews } from '../../src/previews/service.js';
import { api, type Body } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { PocRoomWorld, type Room } from '../helpers/poc-room-world.js';

// REQ-44 r2: a POC room's life past its building — its preview sleeps and a joining member wakes
// it, abandoning removes its branch and keeps its chat, and a schema change stays off shared data
// (BC-9, BC-10, BC-12). The world and its box are poc-room-e2e's (tests/helpers/poc-room-world.ts).

const world = new PocRoomWorld();
const { landing, agreedScreen, read, endTurn, until, liveRoom, ask } = world;
let owner = '';
let member = '';

beforeAll(async () => {
  await world.start();
  ({ owner, member } = world);
}, 120_000);

beforeEach(() => world.reset());

afterAll(() => world.stop());

describe('a room sleeps, wakes, is abandoned, and keeps a schema change off shared data (BC-9, BC-10, BC-12)', () => {
  it('sleeps its preview past the idle setting, keeps its branch, and a joining member wakes it (BC-9)', async () => {
    const key = await agreedScreen('Cart sleeps');
    const room = await liveRoom(key);
    await db.execute(
      sql`UPDATE previews SET last_viewed_at = now() - interval '2 hours' WHERE id = ${room.preview.id}::uuid`,
    );
    await sweepPreviews();
    expect((await read(room.id)).room.preview.state).toBe('idle_closed');
    await settleOutbox();
    expect(world.box.heardOf('preview.stop').at(-1)?.data).toEqual({
      previewId: room.preview.id,
      why: 'idle',
    });
    const starts = world.box.heardOf('preview.start').length;
    const joined = await api(member, 'POST', `/api/rooms/${room.id}/join`);
    expect(joined.status).toBe(200);
    await settleOutbox();
    await expect
      .poll(() => world.box.heardOf('preview.start').length, { timeout: 15_000 })
      .toBe(starts + 1);
    const restart = world.box.heardOf('preview.start').at(-1)?.data as {
      checkout: { branch: string };
    };
    expect(restart.checkout.branch).toBe(room.branch);
    await until(room.id, (r) => r.preview.state === 'live');
  });

  it('removes its branch and preview when abandoned; its chat stays readable (BC-10)', async () => {
    const key = await agreedScreen('Cart abandoned');
    const room = await liveRoom(key);
    await ask(room.id, 'try a sidebar');
    const out = await api(owner, 'POST', `/api/rooms/${room.id}/abandon`, {
      reason: 'not the way',
    });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const gone = out.body.room as Room;
    expect(gone).toMatchObject({ state: 'abandoned', detail: 'not the way' });
    expect(gone.preview.state).toBe('abandoned');
    await settleOutbox();
    expect(world.box.heardOf('preview.stop').at(-1)?.data).toMatchObject({
      previewId: room.preview.id,
      why: 'abandoned',
      drop: { kind: 'sketch', branch: room.branch },
    });
    const later = await read(room.id, member);
    expect(later.status).toBe(200);
    expect(later.room.turns.map((t) => t.ask)).toEqual([
      'Show the cart total in bold',
      'try a sidebar',
    ]);
    const refused = await api(owner, 'POST', `/api/rooms/${room.id}/asks`, { text: 'again' });
    expect((refused.body.error as Body).code).toBe('ROOM_CLOSED');
  });

  it('stops a room whose branch changes the schema while it talks to the dev environment (BC-12)', async () => {
    await landing('dev', 'main', false);
    const key = await agreedScreen('Cart adds a column');
    const room = await liveRoom(key);
    expect(room.data).toBe('environment');
    world.files = ['web/src/cart.tsx', 'packages/core/drizzle/migrations/0999_cart_note.sql'];
    await ask(room.id, 'store a note on the cart');
    await endTurn(room.id);
    const stopped = await until(room.id, (r) => r.preview.state === 'failed');
    expect(stopped.preview.reason).toBe('SCHEMA_NEEDS_THROWAWAY_DATA');
    expect(
      (await api(owner, 'GET', `/api/previews/${room.preview.id}`)).body.preview,
    ).toMatchObject({
      detail: expect.stringContaining('0999_cart_note.sql'),
    });

    // the same change in a room on the project's demo data runs on
    await landing('dev', 'main', true);
    const demoKey = await agreedScreen('Cart adds a column on demo data');
    const demo = await liveRoom(demoKey);
    expect(demo.data).toBe('demo');
    const seeded = world.box
      .heardOf('preview.start')
      .filter((f) => f.data.previewId === demo.preview.id)
      .at(-1);
    expect(seeded?.data).toMatchObject({
      seed: 'npm run seed:demo',
      env: { FORGE_ENVIRONMENT: 'demo' },
    });
    await ask(demo.id, 'store a note on the cart');
    await endTurn(demo.id);
    const on = await until(demo.id, (r) => r.turns.at(-1)?.commit != null);
    expect(on.preview.state).toBe('live');
  });
});
