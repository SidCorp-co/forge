/**
 * The box's WebSocket door reads a box token's fence by the one rule (`credentials/token-fence.ts`,
 * FB-78): a bound project or a list reaches what it names, an empty list reaches nothing, and no
 * list reaches every project the box's holder can see — as the REST door, the MCP door and pool
 * admission read it. No mint path writes an unfenced box token today, so that case is planted.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { mintPat } from '../../src/credentials/pat.js';
import { deviceTokenNameFor } from '../../src/credentials/pat-format.js';
import { projectRoom } from '../../src/lib/rooms.js';
import { attachWs, closeWs } from '../../src/ws/server.js';
import {
  addProjectMember,
  createTestDevice,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

let server: Server;
let url = '';
let ownerId = '';
let projectId = '';
let otherId = '';

beforeAll(async () => {
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  otherId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'owner');
  await addProjectMember(otherId, ownerId, 'owner');
  server = createServer();
  attachWs(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
}, 120_000);

afterAll(async () => {
  await closeWs();
  await new Promise<void>((r) => server.close(() => r()));
});

/** A box token with the fence given, on a box of its own. */
async function boxToken(fence: { projectIds?: string[] | null; boundProjectId?: string }) {
  const deviceId = await createTestDevice(ownerId);
  const { plaintext } = await mintPat({
    userId: ownerId,
    name: deviceTokenNameFor(deviceId),
    permissions: ['*'],
    deviceId,
    ...fence,
  });
  return plaintext;
}

/** What the door answers a box asking for the project room: the room's replay, or a refusal. */
async function subscribeAnswer(bearer: string): Promise<string> {
  const ws = new WebSocket(url, [`forge.bearer.${bearer}`]);
  try {
    return await new Promise<string>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'subscribe', room: projectRoom(projectId), replayMs: 0 })),
      );
      ws.on('message', (raw) => {
        const { event } = JSON.parse(String(raw)) as { event: string };
        if (event === 'replay.done' || event === 'subscribe.denied') resolve(event);
      });
      setTimeout(() => resolve('no answer'), 5_000);
    });
  } finally {
    ws.close();
  }
}

describe('the box WebSocket door reads the token fence by the one rule (FB-78)', () => {
  it('opens a project room to a box token with no fence, as every other door does', async () => {
    expect(await subscribeAnswer(await boxToken({ projectIds: null }))).toBe('replay.done');
  });

  it('refuses the room to a box token whose list is empty', async () => {
    expect(await subscribeAnswer(await boxToken({ projectIds: [] }))).toBe('subscribe.denied');
  });

  it('opens it to a list naming the project and refuses one naming another', async () => {
    expect(await subscribeAnswer(await boxToken({ projectIds: [projectId] }))).toBe('replay.done');
    expect(await subscribeAnswer(await boxToken({ projectIds: [otherId] }))).toBe(
      'subscribe.denied',
    );
  });

  it('reads a bound project alone, whatever the list says', async () => {
    expect(
      await subscribeAnswer(await boxToken({ boundProjectId: otherId, projectIds: null })),
    ).toBe('subscribe.denied');
    expect(
      await subscribeAnswer(await boxToken({ boundProjectId: projectId, projectIds: [otherId] })),
    ).toBe('replay.done');
  });
});
