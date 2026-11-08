/**
 * ISS-1131 (FB-568): the Feedback list, its peek and its grouping read FB-568 as "New · You triage it"
 * after the master had triaged it, while the item's own read said triaged. Core answered each read
 * live; what held the old answer was the open page: a triage wrote no event, so no frame reached the
 * project room, the list's cached read was never marked stale, and the workspace's held glances were
 * never told the project moved. A triage made anywhere but this tab left every open view of it stale.
 *
 * Every feedback decision is written by `feedback/service.ts:decide`, and now reports itself as
 * `decision.settled`: the org-activity consumer marks the project's glances stale and tells the org
 * room, and the ws-broadcast consumer frames it to the project room, whose event router reads the
 * feedback list, its items, Needs you and Attention again.
 *
 * @direct-test-of packages/core/src/feedback/service.ts
 * @direct-test-of packages/core/src/ws/broadcast-subscribers.ts
 * @direct-test-of packages/contracts/src/outbox-consumers.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser } from '../helpers/factories.js';

let say: (who: string, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
const published: { room: string; event: string; data: unknown }[] = [];

const at = (path: string) => `/api/projects/${projectId}${path}`;

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { roomManager } = await import('../../src/lib/rooms.js');
  const publish = roomManager.publish.bind(roomManager);
  vi.spyOn(roomManager, 'publish').mockImplementation((room, msg) => {
    const m = msg as { event: string; data: unknown };
    published.push({ room, event: m.event, data: m.data });
    return publish(room, msg);
  });
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const owner = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(owner)).id;
  say = requester(app, { owner: await signUserToken(owner) });
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await closeWorld();
});

const settled = async (key: string) =>
  (await db.execute(sql`
    SELECT payload FROM pipeline_outbox
     WHERE type = 'decision.settled' AND payload ->> 'projectId' = ${projectId}
       AND payload ->> 'subject' = ${key}
  `)) as unknown as { payload: { act: string } }[];

describe('ISS-1131 a feedback triage tells every open view of it', () => {
  it('writes decision.settled naming the item, framed to the project room', async () => {
    const made = ok(
      await say('owner', 'POST', at('/feedback'), {
        kind: 'bug',
        title: 'Accept asks for an update',
        screen: '/projects/hop/requirements',
      }),
      201,
    );
    const key = made.feedback.key as string;
    // filed: nothing was decided yet, so nothing settled
    expect(await settled(key)).toEqual([]);

    const triaged = ok(
      await say('owner', 'POST', at(`/feedback/${key}/triage`), {
        route: 'decline',
        note: 'Not planned.',
      }),
    );
    expect(triaged.feedback.status).toBe('declined');
    await settleOutbox();

    const rows = await settled(key);
    expect(
      rows.map((r) => r.payload.act),
      'the triage wrote no event any open view hears',
    ).toEqual(['feedback.declined']);
    const frames = published.filter(
      (p) => p.room === `project:${projectId}` && p.event === 'decision.settled',
    );
    expect(frames.map((f) => f.data)).toEqual([
      { projectId, act: 'feedback.declined', subject: key },
    ]);
  }, 60_000);
});
