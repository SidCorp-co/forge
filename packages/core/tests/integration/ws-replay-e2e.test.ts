import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { projectRoom, roomManager } from '../../src/lib/rooms.js';
import { attachWs, closeWs } from '../../src/ws/server.js';
import { userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

// A page whose socket opens after it read its data asks each room for what it missed; the server
// sends those frames, then says it is done and whether it held the whole span.

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

describe('a subscribe that asks for a replay', () => {
  let server: Server;
  let url = '';
  let token = '';
  let projectId = '';
  let strangerToken = '';

  beforeAll(async () => {
    const owner = await createTestUser({ verified: true });
    const stranger = await createTestUser({ verified: true });
    const project = await createTestProject(owner.id);
    await addProjectMember(project.id, owner.id, 'owner');
    projectId = project.id;
    token = await userToken(owner.id);
    strangerToken = await userToken(stranger.id);
    server = createServer();
    attachWs(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  }, 120_000);

  afterAll(async () => {
    await closeWs();
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function subscribe(
    bearer: string,
    message: Record<string, unknown>,
    until: (f: Frame) => boolean,
  ) {
    const ws = new WebSocket(url, [`forge.bearer.${bearer}`]);
    const frames: Frame[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('open', () => ws.send(JSON.stringify(message)));
      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as Frame;
        frames.push(frame);
        if (until(frame)) resolve();
      });
      setTimeout(() => resolve(), 3_000);
    });
    ws.close();
    return frames;
  }

  it('sends the frames the room published in the span, then replay.done', async () => {
    roomManager.publish(projectRoom(projectId), {
      event: 'issue.updated',
      data: { issueId: 'i-1' },
    });
    const frames = await subscribe(
      token,
      { type: 'subscribe', room: projectRoom(projectId), replayMs: 0 },
      (f) => f.event === 'replay.done',
    );
    expect(frames.map((f) => f.event)).toEqual(['issue.updated', 'replay.done']);
    expect(frames[0]?.data).toEqual({ issueId: 'i-1' });
    expect(frames[1]?.data).toMatchObject({ room: projectRoom(projectId), frames: 1 });
    expect(typeof frames[1]?.data.complete).toBe('boolean');
  });

  it('sends no replay to a subscribe that did not ask for one', async () => {
    roomManager.publish(projectRoom(projectId), {
      event: 'issue.updated',
      data: { issueId: 'i-2' },
    });
    const frames = await subscribe(
      token,
      { type: 'subscribe', room: projectRoom(projectId) },
      () => false,
    );
    expect(frames).toEqual([]);
  });

  it('replays nothing into a room the caller may not read', async () => {
    roomManager.publish(projectRoom(projectId), {
      event: 'issue.updated',
      data: { issueId: 'i-3' },
    });
    const frames = await subscribe(
      strangerToken,
      { type: 'subscribe', room: projectRoom(projectId), replayMs: 60_000 },
      (f) => f.event === 'subscribe.denied',
    );
    expect(frames.map((f) => f.event)).toEqual(['subscribe.denied']);
  });
});
