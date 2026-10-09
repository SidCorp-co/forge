// The world the requirement-picture suites (REQ-35, ISS-459) run in: a project with an owner, a
// member and a viewer, a picture of each kind, and the REST doors those suites write and read through.

import { afterAll, beforeAll } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from './ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from './factories.js';

export type Who = 'owner' | 'member' | 'viewer';

export const BOARD = {
  v: 'wireframe-v1',
  title: 'Checkout',
  shapes: [{ id: 'frame', type: 'frame', x: 20, y: 20, w: 400, h: 300 }],
};
const FLOW = {
  nodes: [
    { id: 'cart', label: 'Cart' },
    { id: 'pay', label: 'Pay' },
  ],
  edges: [{ from: 'cart', to: 'pay' }],
};
const CHART = {
  variant: 'bar',
  x: 'week',
  y: ['orders'],
  frame: {
    fields: [
      { name: 'week', label: 'Week', type: 'string' },
      { name: 'orders', label: 'Orders', type: 'number' },
    ],
    rows: [
      { week: 'W1', orders: 3 },
      { week: 'W2', orders: 5 },
    ],
  },
};
export const TABLE = {
  rows: [
    { input: 'A cart of 3 items', expected: 'Shipping is free' },
    { input: 'A cart of 1 item', expected: 'Shipping costs 5' },
  ],
};

export const PICTURES = {
  process: { kind: 'flow', alt: 'A cart leads to payment.', content: FLOW },
  rule: { kind: 'example_table', alt: 'Three items ship free; one pays.', content: TABLE },
  screen: { kind: 'wireframe', alt: 'One checkout frame.', content: { board: BOARD } },
  report: { kind: 'chart', alt: 'Orders rise from 3 to 5.', content: CHART },
} as const;

/** Each kind's picture as a draft carries it (ISS-464): no alt, which core writes from the content. */
export const DRAWN = {
  process: { kind: 'flow', content: FLOW },
  rule: { kind: 'example_table', content: TABLE },
  screen: { kind: 'wireframe', content: { board: BOARD } },
  report: { kind: 'chart', content: CHART },
} as const;

export interface PictureWorld {
  projectId: string;
  ownerId: string;
  memberId: string;
  say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
}

/** Opens the world before the suite's tests and closes it after; its fields fill in `beforeAll`. */
export function openPictureWorld(): PictureWorld {
  const w: PictureWorld = {
    projectId: '',
    ownerId: '',
    memberId: '',
    say: () => Promise.reject(new Error('the picture world is not open yet')),
  };
  beforeAll(async () => {
    testEnv();
    const { app } = await import('../../src/index.js');
    await startQueue();
    const { signUserToken } = await import('../../src/credentials/jwt.js');
    w.ownerId = (await createTestUser({ verified: true })).id;
    w.memberId = (await createTestUser({ verified: true })).id;
    const viewer = (await createTestUser({ verified: true })).id;
    w.projectId = (await createTestProject(w.ownerId)).id;
    await addProjectMember(w.projectId, w.memberId, 'member');
    await addProjectMember(w.projectId, viewer, 'viewer');
    w.say = requester(app, {
      owner: await signUserToken(w.ownerId),
      member: await signUserToken(w.memberId),
      viewer: await signUserToken(viewer),
    });
  }, 120_000);
  afterAll(async () => {
    await closeWorld();
  });
  return w;
}

/** The project-scoped REST doors a picture suite writes and reads a requirement through. */
export function pictureDoors(w: PictureWorld) {
  const as = (who: Who, method: string, path: string, body?: unknown) =>
    w.say(who, method, `/api/projects/${w.projectId}${path}`, body);
  const read = async (key: string): Promise<Doc> =>
    ok(await as('owner', 'GET', `/requirements/${key}`));
  return {
    as,
    read,
    async requirement(title: string, kind?: string | null): Promise<string> {
      return ok(
        await as('owner', 'POST', '/requirements', {
          title,
          reason: 'the rule it states',
          ...(kind === undefined ? {} : { kind }),
          criteria: [{ body: 'A buyer sees what shipping costs before paying.' }],
        }),
        201,
      ).key as string;
    },
    revision: async (key: string, n: number): Promise<Doc> =>
      ((await read(key)).revisions as Doc[]).find((r) => r.revision === n) as Doc,
    history: async (key: string): Promise<string[]> =>
      ((await read(key)).history as Doc[]).map((e) => `${e.kind}: ${e.text}`),
    picture: (key: string, n: number, body: unknown, who: Who = 'owner') =>
      as(who, 'PUT', `/requirements/${key}/revisions/${n}/picture`, body),
    kindOf: (key: string, n: number, kind: string | null, who: Who = 'owner') =>
      as(who, 'PUT', `/requirements/${key}/revisions/${n}/kind`, { kind }),
    async agreeR1(key: string): Promise<void> {
      ok(await as('owner', 'POST', `/requirements/${key}/revisions/1/propose`, {}));
      ok(
        await as('owner', 'POST', `/requirements/${key}/revisions/1/accept`, {
          reason: 'BA review',
        }),
      );
      ok(
        await as('owner', 'POST', `/requirements/${key}/agree`, {
          revision: 1,
          reason: 'owner signed r1',
        }),
      );
    },
  };
}
