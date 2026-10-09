import { SKETCH_BRANCH } from '@forge/contracts/preview';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The preview site, set before the process reads its environment: a development `host:port`.
vi.hoisted(() => {
  process.env.PREVIEW_DOMAIN = 'preview.localhost:7311';
});

import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { api, type Body } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { createTestFeedback } from '../helpers/factories.js';
import { PocRoomWorld, ROOM_MERGE, type Room, snapshotOf } from '../helpers/poc-room-world.js';

// REQ-44 r2 "POC rooms: build live with the owner, deliver only what is settled": opening, joining
// and asking with no gate, settled items, and the settle that merges straight into dev (BC-1..8,
// BC-11), over real sockets — core, the project's app as the room's dev server, and a box that
// answers the preview frames and the agent's turns as forge-runner does. The agent's turn ending is
// the sketch session completing, as a chat session's turn does.

const world = new PocRoomWorld();
const { landing, agreedScreen, read, endTurn, until, turnFrames, liveRoom, ask } = world;
let owner = '';
let member = '';
let stranger = '';
let projectId = '';
let ownerId = '';

beforeAll(async () => {
  await world.start();
  ({ owner, member, stranger, projectId, ownerId } = world);
}, 120_000);

beforeEach(() => world.reset());

afterAll(() => world.stop());

describe('a room is opened, joined and built in with no gate (BC-1, BC-3, BC-4, BC-5, BC-11)', () => {
  it('opens about a requirement as a chat beside a live preview on its own POC branch', async () => {
    const key = await agreedScreen('Cart shows the total');
    const room = await liveRoom(key);
    expect(room).toMatchObject({ state: 'open', data: 'demo', canWrite: true });
    expect(room.branch).toMatch(SKETCH_BRANCH);
    expect(room.preview.state).toBe('live');
    expect(room.members.map((m) => m.userId)).toEqual([ownerId]);
    expect(room.turns).toHaveLength(1);
    expect(room.turns[0]).toMatchObject({
      seq: 1,
      kind: 'ask',
      ask: 'Show the cart total in bold',
    });
  });

  it('tells the agent to edit straight away, and runs its session with every hook off (BC-3)', async () => {
    const key = await agreedScreen('Cart shows a discount');
    const before = turnFrames().length;
    const room = await liveRoom(key, 'Show the discount line');
    const brief = turnFrames()
      .slice(before)
      .find((f) => String(f.data.prompt ?? '').includes('Show the discount line'));
    expect(brief?.data).toMatchObject({ ungated: true, confined: true });
    expect(String(brief?.data.prompt)).toContain('do not build, typecheck, lint, test, review');
    const sent = turnFrames().length;
    const heardBefore = world.box.heard.length;
    await ask(room.id, 'make the discount green');
    await settleOutbox();
    await expect.poll(() => turnFrames().length, { timeout: 15_000 }).toBe(sent + 1);
    const frame = turnFrames().at(-1);
    // the ask reaches the agent verbatim: no wrapper, no check in between
    expect(String(frame?.data.prompt ?? frame?.data.message)).toContain('make the discount green');
    expect(frame?.data).toMatchObject({ ungated: true });
    const between = world.box.heard.slice(heardBefore).map((f) => f.event);
    expect(between.filter((e) => !e.startsWith('agent:'))).toEqual([]);
  });

  it('says when an ask showed and the commit that showed it (BC-4, BC-6)', async () => {
    const key = await agreedScreen('Cart shows taxes');
    const room = await liveRoom(key);
    const asked = await ask(room.id, 'add the tax line');
    const turn = asked.turns.at(-1);
    expect(turn).toMatchObject({ seq: 2, shownAt: null, commit: null });
    await endTurn(room.id);
    const shown = await until(room.id, (r) => r.turns.at(-1)?.commit != null);
    const last = shown.turns.at(-1);
    expect(last?.shownAt).toEqual(expect.any(String));
    expect(last?.shownAfterMs).toEqual(expect.any(Number));
    expect(last?.shownAfterMs).toBeGreaterThanOrEqual(0);
    expect(last?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(world.box.heardOf('preview.snapshot.read').at(-1)?.data).toMatchObject({ keep: true });
  });

  it('lets another member join, see the same preview and ask in it; a stranger is told nothing (BC-5, BC-11)', async () => {
    const key = await agreedScreen('Cart shows shipping');
    const room = await liveRoom(key);
    const joined = await api(member, 'POST', `/api/rooms/${room.id}/join`);
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    const seen = joined.body.room as Room;
    expect(seen.members).toHaveLength(2);
    expect(seen.preview.id).toBe(room.preview.id);
    expect(seen.preview.url).toBe(room.preview.url);
    const asked = await ask(room.id, 'show free shipping over 50', member);
    expect(asked.turns.at(-1)?.ask).toBe('show free shipping over 50');
    expect((await read(room.id)).room.turns.at(-1)?.ask).toBe('show free shipping over 50');
    // a member's ticket enters the same preview
    expect((await api(member, 'POST', `/api/previews/${room.preview.id}/ticket`)).status).toBe(200);
    for (const [method, path, body] of [
      ['GET', `/api/rooms/${room.id}`, undefined],
      ['POST', `/api/rooms/${room.id}/join`, undefined],
      ['POST', `/api/rooms/${room.id}/asks`, { text: 'x' }],
    ] as const) {
      const refused = await api(stranger, method, path, body);
      expect(refused.status, `${method} ${path}`).toBe(404);
      expect((refused.body.error as Body).code).toBe('ROOM_NOT_FOUND');
    }
    const strangerOpen = await api(stranger, 'POST', `/api/projects/${projectId}/rooms`, {
      about: key,
      brief: 'x',
    });
    expect([403, 404]).toContain(strangerOpen.status);
    expect((await api(null, 'GET', `/api/rooms/${room.id}`)).status).toBe(401);
  });
});

describe('an ask into a preview that cannot show it (BC-4)', () => {
  it('is refused by name and kept as no turn when the preview failed', async () => {
    const key = await agreedScreen('Cart shows a failed preview');
    const room = await liveRoom(key);
    const failed = await world.box.report(room.preview.id, {
      kind: 'failed',
      reason: 'PORT_IN_USE',
      detail: '3000 held by pid 9',
    });
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);

    const refused = await api(owner, 'POST', `/api/rooms/${room.id}/asks`, { text: 'make it red' });

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect((refused.body.error as Body).code).toBe('ROOM_ASLEEP');
    expect((await read(room.id)).room.turns).toHaveLength(1);
  });
});

describe('a room preview is asked, kept and abandoned through its room only (BC-3)', () => {
  it('refuses the preview doors by name, so no edit reaches the agent without a turn', async () => {
    const key = await agreedScreen('Cart shows a coupon');
    const room = await liveRoom(key);
    const sent = turnFrames().length;
    for (const [path, body] of [
      ['messages', { text: 'make it red' }],
      ['keep', { alt: 'the cart', snapshot: snapshotOf('the cart') }],
      ['abandon', {}],
    ] as const) {
      const refused = await api(owner, 'POST', `/api/previews/${room.preview.id}/${path}`, body);
      expect(refused.status, `${path} ${JSON.stringify(refused.body)}`).toBe(409);
      expect((refused.body.error as Body).code).toBe('PREVIEW_IS_A_ROOM');
      expect(String((refused.body.error as Body).message)).toContain(`/api/rooms/${room.id}`);
    }
    await settleOutbox();
    expect(turnFrames().length).toBe(sent);
    const after = (await read(room.id)).room;
    expect(after.state).toBe('open');
    expect(after.turns).toHaveLength(1);
    expect(after.preview.state).toBe('live');
  });
});

describe('settled items, and a settle that merges straight into dev (BC-2, BC-6, BC-7, BC-8)', () => {
  it('settles an item only from a turn that showed, tied to its commit', async () => {
    const key = await agreedScreen('Cart shows coupons');
    const room = await liveRoom(key);
    const asked = await ask(room.id, 'add a coupon field');
    const pending = asked.turns.at(-1) as Room['turns'][number];
    const early = await api(owner, 'POST', `/api/rooms/${room.id}/items`, { turnId: pending.id });
    expect(early.status).toBe(409);
    expect((early.body.error as Body).code).toBe('ROOM_TURN_NOT_SHOWN');
    const first = room.turns[0] as Room['turns'][number];
    const item = await api(owner, 'POST', `/api/rooms/${room.id}/items`, { turnId: first.id });
    expect(item.status, JSON.stringify(item.body)).toBe(201);
    expect((item.body.room as Room).items).toEqual([
      expect.objectContaining({ turnId: first.id, commit: first.commit, text: first.ask }),
    ]);
  });

  it('refuses by name to settle into main or the branch production deploys from, and nothing moves (BC-2)', async () => {
    const key = await agreedScreen('Cart shows gift wrap');
    const room = await liveRoom(key);
    await api(owner, 'POST', `/api/rooms/${room.id}/items`, { turnId: room.turns[0]?.id });
    const body = { alt: 'The cart', snapshot: snapshotOf('cart') };
    await landing('main', 'main');
    let refused = await api(owner, 'POST', `/api/rooms/${room.id}/settle`, body);
    expect(refused.status).toBe(422);
    expect((refused.body.error as Body).code).toBe('ROOM_PRODUCTION_BRANCH');
    await landing('release', 'release');
    refused = await api(owner, 'POST', `/api/rooms/${room.id}/settle`, body);
    expect((refused.body.error as Body).code).toBe('ROOM_PRODUCTION_BRANCH');
    expect((await read(room.id)).room.state).toBe('open');
    expect(world.box.heardOf('preview.snapshot.read').some((f) => f.data.settle)).toBe(false);
    const nothing = await agreedScreen('Cart shows nothing settled');
    const bare = await liveRoom(nothing);
    await landing('dev', 'main');
    const empty = await api(owner, 'POST', `/api/rooms/${bare.id}/settle`, body);
    expect((empty.body.error as Body).code).toBe('ROOM_NOTHING_SETTLED');
  });

  it('takes out what was not settled, merges into dev, writes only the settled items and files the follow-up', async () => {
    const key = await agreedScreen('Cart shows the total in bold');
    const room = await liveRoom(key);
    await ask(room.id, 'make it purple');
    await endTurn(room.id);
    await until(room.id, (r) => r.turns.at(-1)?.commit != null);
    await api(owner, 'POST', `/api/rooms/${room.id}/items`, {
      turnId: room.turns[0]?.id,
      text: 'The cart total shows in bold.',
    });

    const before = turnFrames().length;
    const settled = await api(owner, 'POST', `/api/rooms/${room.id}/settle`, {
      alt: 'The cart with a bold total',
      snapshot: snapshotOf('Total 12.00'),
    });
    expect(settled.status, JSON.stringify(settled.body)).toBe(202);
    expect((settled.body.room as Room).state).toBe('settling');
    // the agent is told to take out what was not settled
    await settleOutbox();
    await expect.poll(() => turnFrames().length, { timeout: 15_000 }).toBe(before + 1);
    const trim = String(turnFrames().at(-1)?.data.prompt ?? turnFrames().at(-1)?.data.message);
    expect(trim).toContain('Take out of this branch everything else');
    expect(trim).toContain('make it purple');
    expect(trim).toContain('The cart total shows in bold.');
    expect(world.box.heardOf('preview.snapshot.read').some((f) => f.data.settle)).toBe(false);
    await endTurn(room.id);
    const done = await until(room.id, (r) => r.state === 'settled', 30_000);
    const merge = world.box.heardOf('preview.snapshot.read').find((f) => f.data.settle);
    expect(merge?.data).toMatchObject({ keep: true, settle: { into: 'dev' } });
    const settleAsk = merge?.data.settle as { message: string } | undefined;
    expect(settleAsk?.message).toContain('The cart total shows in bold.');
    expect(done.settle).toMatchObject({
      into: 'dev',
      mergeSha: ROOM_MERGE,
      requirement: key,
      revision: 2,
      refusals: [],
    });

    // BC-7: revision 2 holds the old criteria and the settled item, nothing that was not settled, and the page as its picture
    const detail = (await api(owner, 'GET', `/api/projects/${projectId}/requirements/${key}`)).body;
    const rev2 = (
      detail.revisions as {
        revision: number;
        state: string;
        picture: { kind: string; content: { head: string; asked: string[] } } | null;
      }[]
    ).find((r) => r.revision === 2);
    expect(rev2?.state).toBe('draft');
    expect(rev2?.picture).toMatchObject({
      kind: 'preview',
      content: { asked: ['The cart total shows in bold.'] },
    });
    const criteria = (await db.execute(sql`
      SELECT c.code, c.body FROM requirement_criteria c JOIN requirements r ON r.id = c.requirement_id
       WHERE r.project_id = ${projectId}::uuid AND r.req_seq = ${Number(key.slice(4))} AND c.retired_revision IS NULL ORDER BY c.code
    `)) as unknown as { code: string; body: string }[];
    expect(criteria.map((c) => c.body)).toEqual([
      'A buyer sees the cart total.',
      'The cart total shows in bold.',
    ]);
    expect(JSON.stringify(criteria)).not.toContain('purple');

    // BC-8: the follow-up issue names the merge and asks for verify, review and standards after it, linked to the requirement
    const issueId = done.settle?.issue?.id as string;
    expect(done.settle?.issue?.displayId).toMatch(/^[A-Z]+-\d+$/);
    const [issue] = (await db.execute(sql`
      SELECT i.plan, i.description, i.title, i.requirement_id, r.req_seq FROM issues i LEFT JOIN requirements r ON r.id = i.requirement_id WHERE i.id = ${issueId}::uuid
    `)) as unknown as { plan: string | null; description: string; title: string; req_seq: number }[];
    // what the merge left owed is the body; the plan is the plan step's to write
    expect(issue?.plan).toBeNull();
    expect(issue?.description).toContain(ROOM_MERGE);
    expect(issue?.description).toContain('Verify');
    expect(issue?.description).toContain('Review');
    expect(issue?.description).toContain('code standards');
    expect(issue?.req_seq).toBe(Number(key.slice(4)));

    // the preview closes and the box removes the merged sketch
    const stop = world.box
      .heardOf('preview.stop')
      .filter((f) => f.data.previewId === room.preview.id)
      .at(-1);
    expect(stop?.data).toMatchObject({
      why: 'abandoned',
      drop: { kind: 'sketch', branch: room.branch },
    });
    expect((await read(room.id)).room.preview.state).toBe('abandoned');
    const late = await api(owner, 'POST', `/api/rooms/${room.id}/asks`, { text: 'more' });
    expect((late.body.error as Body).code).toBe('ROOM_CLOSED');
  });

  it('settles on a merge the box reports after core stopped waiting, and refuses an abandon until then', async () => {
    const key = await agreedScreen('Cart shows a late merge');
    const room = await liveRoom(key);
    await api(owner, 'POST', `/api/rooms/${room.id}/items`, { turnId: room.turns[0]?.id });
    // the box was asked to merge and no waiter holds its answer: core restarted, or stopped waiting
    const asked = new Date().toISOString();
    await withKernelMarker(db, (tx) =>
      tx.execute(sql`
        UPDATE poc_rooms SET state = 'settling', settle = ${JSON.stringify({
          into: 'dev',
          askedBy: ownerId,
          askedAt: asked,
          alt: 'The cart',
          snapshot: snapshotOf('cart'),
          mergeAskedAt: asked,
          mergeSha: null,
          requirement: null,
          revision: null,
          issueId: null,
          refusals: [],
        })}::jsonb WHERE id = ${room.id}::uuid
      `),
    );

    const abandon = await api(owner, 'POST', `/api/rooms/${room.id}/abandon`, { reason: 'x' });
    expect(abandon.status, JSON.stringify(abandon.body)).toBe(409);
    expect((abandon.body.error as Body).code).toBe('ROOM_MERGE_PENDING');

    const reported = await world.box.report(room.preview.id, {
      kind: 'snapshot',
      base: 'a'.repeat(40),
      patchId: 'd'.repeat(40),
      files: ['web/src/cart.tsx'],
      head: 'c'.repeat(40),
      merged: { into: 'dev', sha: ROOM_MERGE },
    });
    expect(reported.status, JSON.stringify(reported.body)).toBe(200);
    const done = await until(room.id, (r) => r.state === 'settled', 30_000);
    expect(done.settle).toMatchObject({ into: 'dev', mergeSha: ROOM_MERGE, requirement: key });
  });

  it('goes back to open, naming git, when the merge does not land, and writes nothing', async () => {
    const key = await agreedScreen('Cart shows a conflict');
    const room = await liveRoom(key);
    await api(owner, 'POST', `/api/rooms/${room.id}/items`, { turnId: room.turns[0]?.id });
    world.mergeAnswer = () => ({
      mergeRefused:
        'the merge of sketch/x into dev conflicts: CONFLICT (content): web/src/cart.tsx',
    });
    const settled = await api(owner, 'POST', `/api/rooms/${room.id}/settle`, {
      alt: 'The cart',
      snapshot: snapshotOf('cart'),
    });
    expect(settled.status, JSON.stringify(settled.body)).toBe(202);
    const back = await until(room.id, (r) => r.state === 'open' && r.detail !== null, 30_000);
    expect(back.detail).toContain('did not land');
    expect(back.detail).toContain('CONFLICT');
    expect(back.settle).toBeNull();
    const revisions = (await db.execute(sql`
      SELECT count(*)::int AS n FROM requirement_revisions v JOIN requirements r ON r.id = v.requirement_id
       WHERE r.project_id = ${projectId}::uuid AND r.req_seq = ${Number(key.slice(4))}
    `)) as unknown as { n: number }[];
    expect(revisions[0]?.n).toBe(1);
  });

  it('settles a room about a feedback item into a new screen requirement started from it', async () => {
    const fb = await createTestFeedback(projectId, ownerId, world.nextFeedbackSeq());
    const room = await liveRoom(fb, 'Show the board filter');
    await api(owner, 'POST', `/api/rooms/${room.id}/items`, {
      turnId: room.turns[0]?.id,
      text: 'The board filters by owner.',
    });
    const settled = await api(owner, 'POST', `/api/rooms/${room.id}/settle`, {
      alt: 'The board filtered',
      snapshot: snapshotOf('board'),
    });
    expect(settled.status, JSON.stringify(settled.body)).toBe(202);
    const done = await until(room.id, (r) => r.state === 'settled', 30_000);
    expect(done.settle).toMatchObject({ mergeSha: ROOM_MERGE, revision: 1 });
    expect(done.settle?.requirement).toMatch(/^REQ-\d+$/);
    expect(done.settle?.issue).not.toBeNull();
  });
});
