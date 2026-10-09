import { randomUUID } from 'node:crypto';
import { SKETCH_BRANCH } from '@forge/contracts/preview';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The preview site, set before the process reads its environment: a development `host:port`.
vi.hoisted(() => {
  process.env.PREVIEW_DOMAIN = 'preview.localhost:7311';
});

import { eq, sql } from 'drizzle-orm';
import { transitionSessions } from '../../src/agent-sessions/index.js';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { agentSessions } from '../../src/db/schema.js';
import { sweepPreviews } from '../../src/previews/service.js';
import { api, type Body } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { createTestFeedback } from '../helpers/factories.js';
import { SUBJECT_ENVIRONMENTS, SubjectsWorld } from '../helpers/preview-subjects-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

// REQ-44 r2 "POC rooms: build live with the owner, deliver only what is settled", BC-1..12, driven
// over real sockets: core, the project's app as the room's dev server, and a box that answers the
// preview frames and the agent's turns as forge-runner does. The agent's turn ending is the sketch
// session completing, as a chat session's turn does.

const world = new SubjectsWorld();
let owner = '';
let member = '';
let stranger = '';
let projectId = '';
let ownerId = '';
let reqSeq = 9000;
let fbSeq = 300;

const BASE = 'a'.repeat(40);
const PATCH = 'd'.repeat(40);
const MERGE = 'e'.repeat(40);
let heads = 0;
const nextHead = () => (heads += 1).toString(16).padStart(40, 'c');

/** What the box answers a snapshot ask with; a test swaps in a refused merge or a schema change. */
let files = ['web/src/cart.tsx'];
let mergeAnswer: (into: string) => Record<string, unknown> = (into) => ({
  merged: { into, sha: MERGE },
});

const snapshotOf = (text: string) => [
  { type: 4, timestamp: 1, data: { href: 'http://x.invalid/', width: 800, height: 600 } },
  {
    type: 2,
    timestamp: 2,
    data: { node: { type: 0, childNodes: [{ type: 3, textContent: text, id: 2 }], id: 1 } },
  },
];

/** The project's document: work lands on `defaultBranch`, production deploys from `deploysFrom`. */
async function landing(defaultBranch: string, deploysFrom: string, demo = true) {
  await seedProjectDocument(projectId, ownerId, {
    defaultBranch,
    environments: {
      ...SUBJECT_ENVIRONMENTS,
      live: { ...SUBJECT_ENVIRONMENTS.live, deploysFrom },
    } as never,
    extra: {
      preview: {
        command: 'npm run dev -- --port {port}',
        ...(demo ? { demo: { environment: 'demo', seed: 'npm run seed:demo' } } : {}),
      },
    },
  });
}

/** An agreed screen requirement with one criterion, as the BA leaves one. */
async function agreedScreen(title: string): Promise<string> {
  const [top] = (await db.execute(
    sql`SELECT coalesce(max(req_seq), 0)::int AS n FROM requirements WHERE project_id = ${projectId}::uuid`,
  )) as unknown as { n: number }[];
  reqSeq = Math.max(reqSeq, top?.n ?? 0) + 1;
  const id = randomUUID();
  await withKernelMarker(db, async (tx) => {
    await tx.execute(sql`
      INSERT INTO requirements (id, project_id, req_seq, title, status)
      VALUES (${id}, ${projectId}, ${reqSeq}, ${title}, 'draft')
    `);
    await tx.execute(sql`
      INSERT INTO requirement_revisions
        (requirement_id, revision, state, spec, reason, kind, author_id, author_agency, decided_by, decided_at)
      VALUES (${id}, 1, 'current', '{}'::jsonb, 'first cut', 'screen', ${ownerId}, 'human', ${ownerId}, now())
    `);
    await tx.execute(
      sql`UPDATE requirements SET current_revision = 1, status = 'agreed' WHERE id = ${id}`,
    );
  });
  await db.execute(sql`
    INSERT INTO requirement_criteria (requirement_id, code, body, since_revision)
    VALUES (${id}, 'BC-1', 'A buyer sees the cart total.', 1)
  `);
  return `REQ-${reqSeq}`;
}

type Room = {
  id: string;
  state: string;
  detail: string | null;
  data: string;
  branch: string;
  preview: { id: string; state: string; reason: string | null; url: string };
  members: { userId: string; name: string }[];
  turns: {
    id: string;
    seq: number;
    kind: string;
    ask: string;
    shownAt: string | null;
    shownAfterMs: number | null;
    commit: string | null;
  }[];
  items: { id: string; turnId: string; commit: string; text: string }[];
  settle: {
    into: string;
    mergeSha: string | null;
    requirement: string | null;
    revision: number | null;
    issue: { id: string; displayId: string | null } | null;
    refusals: { code: string; detail: string }[];
  } | null;
  canWrite: boolean;
};

const read = async (id: string, who = owner) => {
  const got = await api(who, 'GET', `/api/rooms/${id}`);
  return { status: got.status, body: got.body, room: got.body.room as Room };
};

async function sessionOf(roomId: string): Promise<string> {
  const rows = (await db.execute(
    sql`SELECT session_id FROM poc_rooms WHERE id = ${roomId}::uuid`,
  )) as unknown as { session_id: string }[];
  return rows[0]?.session_id as string;
}

/** The room agent's turn ends: its sketch session is `completed`, as a chat session's is. */
async function endTurn(roomId: string): Promise<void> {
  const sessionId = await sessionOf(roomId);
  await transitionSessions(db, {
    to: 'completed',
    where: eq(agentSessions.id, sessionId),
    actor: { type: 'system' },
    source: 'poc-room-e2e',
  });
}

const until = async (id: string, pred: (r: Room) => boolean, ms = 20_000) => {
  await expect.poll(async () => pred((await read(id)).room), { timeout: ms, interval: 100 }).toBe(true);
  return (await read(id)).room;
};

const turnFrames = () => [...world.box.heardOf('agent:start'), ...world.box.heardOf('agent:send')];

/** A room open and live, its brief taken by the agent and shown. */
async function liveRoom(about: string, brief = 'Show the cart total in bold'): Promise<Room> {
  world.serveApp();
  const opened = await api(owner, 'POST', `/api/projects/${projectId}/rooms`, { about, brief });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const room = opened.body.room as Room;
  await settleOutbox();
  await until(room.id, (r) => r.preview.state === 'live');
  await expect.poll(() => turnFrames().some((f) => String(f.data.prompt ?? '').includes(brief)), { timeout: 15_000 }).toBe(true);
  await endTurn(room.id);
  return until(room.id, (r) => r.turns[0]?.commit !== null && r.turns[0]?.commit !== undefined);
}

async function ask(id: string, text: string, who = owner): Promise<Room> {
  const sent = await api(who, 'POST', `/api/rooms/${id}/asks`, { text });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  return sent.body.room as Room;
}

beforeAll(async () => {
  await world.start();
  ({ owner, member, stranger, projectId, ownerId } = world);
  // the world's issues were written with their numbers by hand; the counter a filed issue takes from is moved past them
  await db.execute(sql`
    INSERT INTO project_iss_counters (project_id, next_seq) VALUES (${projectId}, 1000)
    ON CONFLICT (project_id) DO UPDATE SET next_seq = 1000
  `);
  world.box.onSnapshot = (frame) => {
    const settle = frame.settle as { into: string } | undefined;
    return {
      kind: 'snapshot',
      base: BASE,
      patchId: PATCH,
      files,
      ...(frame.keep ? { head: nextHead() } : {}),
      ...(settle ? mergeAnswer(settle.into) : {}),
    };
  };
}, 120_000);

beforeEach(async () => {
  files = ['web/src/cart.tsx'];
  mergeAnswer = (into) => ({ merged: { into, sha: MERGE } });
  await landing('dev', 'main');
});

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
    expect(room.turns[0]).toMatchObject({ seq: 1, kind: 'ask', ask: 'Show the cart total in bold' });
  });

  it('tells the agent to edit straight away, and runs its session with every hook off (BC-3)', async () => {
    const key = await agreedScreen('Cart shows a discount');
    const before = turnFrames().length;
    const room = await liveRoom(key, 'Show the discount line');
    const brief = turnFrames().slice(before).find((f) => String(f.data.prompt ?? '').includes('Show the discount line'));
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
    const strangerOpen = await api(stranger, 'POST', `/api/projects/${projectId}/rooms`, { about: key, brief: 'x' });
    expect([403, 404]).toContain(strangerOpen.status);
    expect((await api(null, 'GET', `/api/rooms/${room.id}`)).status).toBe(401);
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
    await api(owner, 'POST', `/api/rooms/${room.id}/items`, { turnId: room.turns[0]?.id, text: 'The cart total shows in bold.' });

    const before = turnFrames().length;
    const settled = await api(owner, 'POST', `/api/rooms/${room.id}/settle`, { alt: 'The cart with a bold total', snapshot: snapshotOf('Total 12.00') });
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
    expect(String((merge?.data.settle as { message: string }).message)).toContain('The cart total shows in bold.');
    expect(done.settle).toMatchObject({ into: 'dev', mergeSha: MERGE, requirement: key, revision: 2, refusals: [] });

    // BC-7: revision 2 holds the old criteria and the settled item, nothing that was not settled, and the page as its picture
    const detail = (await api(owner, 'GET', `/api/projects/${projectId}/requirements/${key}`)).body;
    const rev2 = (detail.revisions as { revision: number; state: string; picture: { kind: string; content: { head: string; asked: string[] } } | null }[]).find((r) => r.revision === 2);
    expect(rev2?.state).toBe('draft');
    expect(rev2?.picture).toMatchObject({ kind: 'preview', content: { asked: ['The cart total shows in bold.'] } });
    const criteria = (await db.execute(sql`
      SELECT c.code, c.body FROM requirement_criteria c JOIN requirements r ON r.id = c.requirement_id
       WHERE r.project_id = ${projectId}::uuid AND r.req_seq = ${Number(key.slice(4))} AND c.retired_revision IS NULL ORDER BY c.code
    `)) as unknown as { code: string; body: string }[];
    expect(criteria.map((c) => c.body)).toEqual(['A buyer sees the cart total.', 'The cart total shows in bold.']);
    expect(JSON.stringify(criteria)).not.toContain('purple');

    // BC-8: the follow-up issue names the merge and asks for verify, review and standards after it, linked to the requirement
    const issueId = done.settle?.issue?.id as string;
    expect(done.settle?.issue?.displayId).toMatch(/^[A-Z]+-\d+$/);
    const [issue] = (await db.execute(sql`
      SELECT i.plan, i.title, i.requirement_id, r.req_seq FROM issues i LEFT JOIN requirements r ON r.id = i.requirement_id WHERE i.id = ${issueId}::uuid
    `)) as unknown as { plan: string; title: string; req_seq: number }[];
    expect(issue?.plan).toContain(MERGE);
    expect(issue?.plan).toContain('Verify');
    expect(issue?.plan).toContain('Review');
    expect(issue?.plan).toContain('code standards');
    expect(issue?.req_seq).toBe(Number(key.slice(4)));

    // the preview closes and the box removes the merged sketch
    const stop = world.box.heardOf('preview.stop').filter((f) => f.data.previewId === room.preview.id).at(-1);
    expect(stop?.data).toMatchObject({ why: 'abandoned', drop: { kind: 'sketch', branch: room.branch } });
    expect((await read(room.id)).room.preview.state).toBe('abandoned');
    const late = await api(owner, 'POST', `/api/rooms/${room.id}/asks`, { text: 'more' });
    expect((late.body.error as Body).code).toBe('ROOM_CLOSED');
  });

  it('goes back to open, naming git, when the merge does not land, and writes nothing', async () => {
    const key = await agreedScreen('Cart shows a conflict');
    const room = await liveRoom(key);
    await api(owner, 'POST', `/api/rooms/${room.id}/items`, { turnId: room.turns[0]?.id });
    mergeAnswer = () => ({ mergeRefused: 'the merge of sketch/x into dev conflicts: CONFLICT (content): web/src/cart.tsx' });
    const settled = await api(owner, 'POST', `/api/rooms/${room.id}/settle`, { alt: 'The cart', snapshot: snapshotOf('cart') });
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
    fbSeq += 1;
    const fb = await createTestFeedback(projectId, ownerId, fbSeq);
    const room = await liveRoom(fb, 'Show the board filter');
    await api(owner, 'POST', `/api/rooms/${room.id}/items`, { turnId: room.turns[0]?.id, text: 'The board filters by owner.' });
    const settled = await api(owner, 'POST', `/api/rooms/${room.id}/settle`, { alt: 'The board filtered', snapshot: snapshotOf('board') });
    expect(settled.status, JSON.stringify(settled.body)).toBe(202);
    const done = await until(room.id, (r) => r.state === 'settled', 30_000);
    expect(done.settle).toMatchObject({ mergeSha: MERGE, revision: 1 });
    expect(done.settle?.requirement).toMatch(/^REQ-\d+$/);
    expect(done.settle?.issue).not.toBeNull();
  });
});

describe('a room sleeps, wakes, is abandoned, and keeps a schema change off shared data (BC-9, BC-10, BC-12)', () => {
  it('sleeps its preview past the idle setting, keeps its branch, and a joining member wakes it (BC-9)', async () => {
    const key = await agreedScreen('Cart sleeps');
    const room = await liveRoom(key);
    await db.execute(sql`UPDATE previews SET last_viewed_at = now() - interval '2 hours' WHERE id = ${room.preview.id}::uuid`);
    await sweepPreviews();
    expect((await read(room.id)).room.preview.state).toBe('idle_closed');
    await settleOutbox();
    expect(world.box.heardOf('preview.stop').at(-1)?.data).toEqual({ previewId: room.preview.id, why: 'idle' });
    const starts = world.box.heardOf('preview.start').length;
    const joined = await api(member, 'POST', `/api/rooms/${room.id}/join`);
    expect(joined.status).toBe(200);
    await settleOutbox();
    await expect.poll(() => world.box.heardOf('preview.start').length, { timeout: 15_000 }).toBe(starts + 1);
    const restart = world.box.heardOf('preview.start').at(-1)?.data as { checkout: { branch: string } };
    expect(restart.checkout.branch).toBe(room.branch);
    await until(room.id, (r) => r.preview.state === 'live');
  });

  it('removes its branch and preview when abandoned; its chat stays readable (BC-10)', async () => {
    const key = await agreedScreen('Cart abandoned');
    const room = await liveRoom(key);
    await ask(room.id, 'try a sidebar');
    const out = await api(owner, 'POST', `/api/rooms/${room.id}/abandon`, { reason: 'not the way' });
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
    expect(later.room.turns.map((t) => t.ask)).toEqual(['Show the cart total in bold', 'try a sidebar']);
    const refused = await api(owner, 'POST', `/api/rooms/${room.id}/asks`, { text: 'again' });
    expect((refused.body.error as Body).code).toBe('ROOM_CLOSED');
  });

  it('stops a room whose branch changes the schema while it talks to the dev environment (BC-12)', async () => {
    await landing('dev', 'main', false);
    const key = await agreedScreen('Cart adds a column');
    const room = await liveRoom(key);
    expect(room.data).toBe('environment');
    files = ['web/src/cart.tsx', 'packages/core/drizzle/migrations/0999_cart_note.sql'];
    await ask(room.id, 'store a note on the cart');
    await endTurn(room.id);
    const stopped = await until(room.id, (r) => r.preview.state === 'failed');
    expect(stopped.preview.reason).toBe('SCHEMA_NEEDS_THROWAWAY_DATA');
    expect((await api(owner, 'GET', `/api/previews/${room.preview.id}`)).body.preview).toMatchObject({
      detail: expect.stringContaining('0999_cart_note.sql'),
    });

    // the same change in a room on the project's demo data runs on
    await landing('dev', 'main', true);
    const demoKey = await agreedScreen('Cart adds a column on demo data');
    const demo = await liveRoom(demoKey);
    expect(demo.data).toBe('demo');
    const seeded = world.box.heardOf('preview.start').filter((f) => f.data.previewId === demo.preview.id).at(-1);
    expect(seeded?.data).toMatchObject({ seed: 'npm run seed:demo', env: { FORGE_ENVIRONMENT: 'demo' } });
    await ask(demo.id, 'store a note on the cart');
    await endTurn(demo.id);
    const on = await until(demo.id, (r) => r.turns.at(-1)?.commit != null);
    expect(on.preview.state).toBe('live');
  });
});
