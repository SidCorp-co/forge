// ISS-1006 round 2: opening Ask Agent waited 4 s and more on "Opening your latest conversation…" on
// forge-dev. The dock waits on one read, `GET /api/conversations?projectId=`, and that read decided
// which rooms the caller sees one room at a time: a scope read per room, and a people read per
// direct room, serially, over every room the project has ever had. Here the decision is two reads
// for any number of rooms, and the list it answers is the one the per-room loop answered: a group
// room listed to a project member outside it, a direct room only to the person in it.
// Planted red by deciding it room by room again.
//
// @direct-test-of packages/core/src/conversations/scope.ts
// @direct-test-of packages/core/src/assistant/conversation-routes.ts

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { db } = await import('../../src/db/client.js');
const { listConversationsInProject, listableRooms } = await import(
  '../../src/conversations/index.js'
);
const { api, userToken } = await import('../helpers/api.js');
const { closeWorld, testEnv } = await import('../helpers/ecosystem-world.js');
const { addProjectMember, createTestProject, createTestUser } = await import(
  '../helpers/factories.js'
);

const GROUP_ROOMS = 90;
const DIRECT_ROOMS = 30;

let projectId = '';
let owner = '';
let outsider = '';
let token = '';
let outsiderToken = '';
const group: string[] = [];
const direct: string[] = [];

/** The database, counting each statement a read sends through it. */
function counting(): { executor: typeof db; reads: () => number } {
  let n = 0;
  const sends = new Set(['select', 'selectDistinct', 'selectDistinctOn', 'execute']);
  const executor = new Proxy(db, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      if (!sends.has(String(key))) return value.bind(target);
      return (...args: unknown[]) => {
        n += 1;
        return value.apply(target, args);
      };
    },
  });
  return { executor, reads: () => n };
}

async function open(people: string[]): Promise<string> {
  const res = await api(token, 'POST', '/api/conversations', { projectId, title: 'room', people });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.id);
}

beforeAll(async () => {
  testEnv();
  owner = (await createTestUser({ verified: true })).id;
  token = await userToken(owner);
  projectId = (await createTestProject(owner)).id;
  const colleague = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, colleague);
  outsider = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, outsider);
  outsiderToken = await userToken(outsider);
  for (let i = 0; i < GROUP_ROOMS; i += 1) group.push(await open([colleague]));
  for (let i = 0; i < DIRECT_ROOMS; i += 1) direct.push(await open([]));
}, 300_000);

afterAll(async () => {
  await closeWorld();
});

describe('which rooms a caller sees is read for all of them at once', () => {
  it('takes two reads whatever the number of rooms', async () => {
    const all = await listConversationsInProject(projectId, { archived: false });
    expect(all).toHaveLength(GROUP_ROOMS + DIRECT_ROOMS);
    const few = counting();
    await listableRooms(all.slice(0, 5), owner, few.executor);
    const many = counting();
    await listableRooms(all, owner, many.executor);
    expect(many.reads()).toBe(2);
    expect(many.reads()).toBe(few.reads());
  });

  it('lists a group room to a member outside it, and a direct room only to the person in it', async () => {
    const all = await listConversationsInProject(projectId, { archived: false });
    const mine = new Set((await listableRooms(all, owner)).map((r) => r.id));
    const theirs = new Set((await listableRooms(all, outsider)).map((r) => r.id));
    for (const id of group) {
      expect(mine.has(id)).toBe(true);
      expect(theirs.has(id)).toBe(true);
    }
    for (const id of direct) {
      expect(mine.has(id)).toBe(true);
      expect(theirs.has(id)).toBe(false);
    }
  });

  it('answers the dock its list, and says how long the read took', async () => {
    const timed = async (as: string) => {
      const started = performance.now();
      const res = await api(as, 'GET', `/api/conversations?projectId=${projectId}&pageSize=50`);
      const ms = performance.now() - started;
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return { ms, total: Number(res.body.total) };
    };
    await timed(token);
    const runs = [];
    for (let i = 0; i < 5; i += 1) runs.push(await timed(token));
    const outsiderRead = await timed(outsiderToken);
    expect(runs[0]?.total).toBe(GROUP_ROOMS + DIRECT_ROOMS);
    expect(outsiderRead.total).toBe(GROUP_ROOMS);
    const median = runs.map((r) => r.ms).sort((a, b) => a - b)[2] ?? 0;
    process.stdout.write(
      `[ISS-1006 dock] GET /api/conversations over ${GROUP_ROOMS + DIRECT_ROOMS} rooms: median ${median.toFixed(0)} ms of 5\n`,
    );
  });
});
