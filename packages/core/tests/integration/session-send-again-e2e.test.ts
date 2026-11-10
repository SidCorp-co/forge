import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChatSessionRow } from '../../src/agent-sessions/chat-turn.js';
import {
  confirmSessionSend,
  requestSessionSend,
  sessionSendStanding,
} from '../../src/agent-sessions/session-send.js';
import { closeWorld, startQueue } from '../helpers/ecosystem-world.js';
import { createTestDevice, createTestProject, createTestUser } from '../helpers/factories.js';

// @direct-test-of packages/core/src/agent-sessions/session-send.ts
//
// ISS-1202: a room's message written into a turn the box no longer ran was refused `gone`; given
// back and written into the next turn under the same intent, core sent the same seq again inside
// its episode without opening a new one, so the box's honest `delivered` was refused
// SEND_ALREADY_SETTLED and the message read as never taken. A refused send asked again is a new
// episode.

let sessionId = '';

beforeAll(async () => {
  await startQueue();
  const owner = (await createTestUser({ verified: true })).id;
  const projectId = (await createTestProject(owner)).id;
  const deviceId = await createTestDevice(owner);
  sessionId = (await createChatSessionRow({ projectId, userId: owner, deviceId, title: 'room' }))
    .id;
}, 120_000);

afterAll(() => closeWorld());

describe('ISS-1202: a send the box refused, asked again, is a new episode', () => {
  it('takes the box delivering it on the second ask, after it refused the first', async () => {
    const ask = () =>
      requestSessionSend({
        agentSessionId: sessionId,
        kind: 'inject',
        intentId: 'support:again',
        body: 'more',
      });
    const first = await ask();
    expect(first.published).toBe(true);
    await confirmSessionSend(sessionId, first.row.seq, 'gone');
    const again = await ask();
    expect(again).toMatchObject({ published: true, duplicate: true });
    expect(again.row.seq).toBe(first.row.seq);
    expect(again.row.sendOutcome).toBeNull();
    // [SEND_ALREADY_SETTLED before the fix]
    await confirmSessionSend(sessionId, again.row.seq, 'delivered');
    expect((await sessionSendStanding(sessionId, again.row.seq))?.confirmed).toBe('delivered');
  });

  it('keeps one episode for a send the box took: asked again, it is not reopened', async () => {
    const ask = () =>
      requestSessionSend({
        agentSessionId: sessionId,
        kind: 'inject',
        intentId: 'support:taken',
        body: 'once',
      });
    const first = await ask();
    await confirmSessionSend(sessionId, first.row.seq, 'delivered');
    const again = await ask();
    expect(again.row.sendOutcome).toBe('delivered');
    await expect(confirmSessionSend(sessionId, first.row.seq, 'gone')).rejects.toThrow(
      /SEND_ALREADY_SETTLED/,
    );
  });
});
