/**
 * ISS-1335 (FB-745): a box whose opener can no longer drive it, its credential refused every call
 * after the open or its run gone, held its device's room with nothing to close it. The sweep closes
 * an agent's box nothing used for `BOX_LIMITS.agentIdleSeconds`, on the record, tells the device to
 * reap it, and its record says why it closed; a box its caller closed says so too.
 *
 * @direct-test-of packages/core/src/boxes/allocate.ts
 * @direct-test-of packages/core/src/boxes/read.ts
 * @direct-test-of packages/core/src/boxes/service.ts
 */

import { BOX_LIMITS } from '@forge/contracts/boxes';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { closeWorld, type Doc } from '../helpers/ecosystem-world.js';
import { type BoxWorld, boxFrames, boxWorld, healthy } from '../helpers/forge-box-world.js';

let w: BoxWorld;

beforeAll(async () => {
  w = await boxWorld();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** Open a browser box and bring it up; `up` are the boxes the device still holds (else gone). */
async function runningBox(criterion: number, up: string[] = []): Promise<string> {
  await w.beat(healthy({}, up));
  const opened = await w.say('agent', 'POST', `/api/projects/${w.projectId}/boxes`, {
    mode: 'browser',
    issueId: w.issueId,
    criterion,
    runId: 'run-i',
  });
  expect(opened.status, JSON.stringify(opened.json)).toBe(201);
  const id = (opened.json.box as Doc).id as string;
  await w.say('device', 'POST', `/api/boxes/${id}/report`, {
    kind: 'state',
    state: 'ready',
    offer: { codec: 'jpeg-frames', width: 390, height: 844 },
  });
  expect(await w.box(id)).toMatchObject({ state: 'agent' });
  return id;
}

/** Date the box's start `seconds` back, as if it had stood that long. */
const startedAgo = (id: string, seconds: number) =>
  db.execute(sql`
    UPDATE boxes SET opened_at = now() - make_interval(secs => ${seconds}),
                     ready_at = now() - make_interval(secs => ${seconds})
     WHERE id = ${id}`);

const sweep = async () => (await import('../../src/boxes/index.js')).sweepBoxes();

describe('a box nothing used closes idle (ISS-1335)', () => {
  it('closes an agent box idle past the limit on the record, and leaves one used within it', async () => {
    const idle = await runningBox(1);
    const used = await runningBox(2, [idle]);
    const limit = BOX_LIMITS.agentIdleSeconds;

    // just under the limit: nothing closes
    await startedAgo(idle, limit - 60);
    await sweep();
    expect(await w.box(idle)).toMatchObject({ state: 'agent', closedWhy: null });

    // the used box stood two limits, and its agent acted on it just now
    await startedAgo(used, limit * 2);
    const reading = w.say('agent', 'POST', `/api/boxes/${used}/acts`, { command: ['snapshot'] });
    await expect.poll(async () => (await boxFrames(used, 'box.act')).length).toBe(1);
    const sent = (await boxFrames(used, 'box.act'))[0]?.data as Doc;
    await w.say('device', 'POST', `/api/boxes/${used}/report`, {
      kind: 'act',
      actId: sent.actId,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 7,
    });
    expect((await reading).json).toMatchObject({ act: { state: 'done' } });

    await startedAgo(idle, limit + 60);
    await sweep();
    expect(await w.box(idle)).toMatchObject({ state: 'closed', closedWhy: 'idle' });
    const moves = (await db.execute(sql`
      SELECT from_status, to_status, actor_type, reason FROM kernel_transitions
       WHERE entity = 'box' AND entity_id = ${idle} ORDER BY created_at`)) as unknown as Doc[];
    expect(moves.at(-1)).toMatchObject({
      from_status: 'agent',
      to_status: 'closed',
      actor_type: 'sweeper',
      reason: `nothing used it for ${limit}s: closed idle`,
    });
    expect((await boxFrames(idle, 'box.close')).at(-1)?.data).toEqual({ boxId: idle, why: 'idle' });

    expect(await w.box(used)).toMatchObject({ state: 'agent', closedWhy: null });
    const closed = await w.say('agent', 'POST', `/api/boxes/${used}/close`, {});
    expect(closed.json.box).toMatchObject({ state: 'closed', closedWhy: 'done' });
  });
});
