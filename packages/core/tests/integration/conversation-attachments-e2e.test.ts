/**
 * ISS-1146 — the web door a file walks through, end to end: the mint, the PUT
 * that carries the bytes, the send that cites what they became, and the two
 * refusals that stop it being a door into somebody else's room or a door for
 * a type a conversation cannot read.
 *
 * No web transport is registered here, so each send logs that its window had
 * nowhere to deliver an answer. That is the boundary of what this file claims:
 * it judges the door a file walks through and the row the message becomes, not
 * the turn that reads it.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

/** A one-pixel PNG — real bytes, so the type resolution is not being humoured. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let harness: TestDatabase;
let app: Hono;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let store: typeof import('../../src/conversations/store.js');
let participants: typeof import('../../src/conversations/participants.js');

/**
 * Somewhere outside the checkout for the bytes to land. `UPLOADS_DIR` defaults
 * to `./uploads`, which is the working tree — this is the first integration
 * test that persists an attachment, and it is not going to leave one there.
 */
const uploadsDir = mkdtempSync(join(tmpdir(), 'forge-conversation-uploads-'));

beforeAll(async () => {
  process.env.UPLOADS_DIR = uploadsDir;
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const { conversationRoutes } = await import('../../src/assistant/conversation-routes.js');
  const { uploadRoutes } = await import('../../src/uploads/routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;
  store = await import('../../src/conversations/store.js');
  participants = await import('../../src/conversations/participants.js');

  app = new Hono();
  app.use('*', requestId());
  app.route('/api/conversations', conversationRoutes);
  app.route('/api/uploads', uploadRoutes);
  app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
}, 180_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
  rmSync(uploadsDir, { recursive: true, force: true });
});

let token: string;
let userId: string;
let projectId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const user = await createTestUser(harness.db);
  userId = user.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  projectId = project.id;
  await createTestProjectMember(harness.db, { userId, projectId, role: 'member' });
  token = await signUserToken(userId);
});

/** A room the Forge UI opened, with this person in it. */
async function room(): Promise<string> {
  const opened = await store.openConversation({
    adapter: 'web',
    externalId: `web ${randomUUID()}`,
    shape: 'direct',
    projectId,
  });
  await participants.addPerson({ conversationId: opened.id, userId });
  return opened.id;
}

const post = (path: string, body?: unknown) =>
  app.request(`http://localhost${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function mint(conversationId: string, name: string, mime: string) {
  const res = await post(`/api/conversations/${conversationId}/attachments`, { name, mime });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function put(uploadId: string, bytes: Buffer) {
  const res = await app.request(`http://localhost/api/uploads/${uploadId}`, {
    method: 'PUT',
    body: new Uint8Array(bytes),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function upload(conversationId: string): Promise<string> {
  const ticket = await mint(conversationId, 'screenshot.png', 'image/png');
  expect(ticket.status).toBe(201);
  const stored = await put(ticket.body.uploadId as string, PNG);
  expect(stored.status).toBe(201);
  return stored.body.id as string;
}

describe('the door a file walks into a web conversation through', () => {
  it('mints a ticket that names where the bytes go', async () => {
    const id = await room();
    const ticket = await mint(id, 'screenshot.png', 'image/png');
    expect(ticket.status).toBe(201);
    expect(ticket.body.uploadPath).toBe(`/api/uploads/${ticket.body.uploadId}`);
    expect(ticket.body.method).toBe('PUT');
  });

  it('refuses at the mint a type a conversation cannot read, naming it', async () => {
    const id = await room();
    const ticket = await mint(id, 'spec.pdf', 'application/pdf');
    expect(ticket.status).toBe(400);
    expect(String(ticket.body.message)).toContain('application/pdf');
    expect(ticket.body.code).toBe('MIME_NOT_ALLOWED');
  });

  it('says what it does take, so the refusal can be printed rather than guessed', async () => {
    const id = await room();
    const ticket = await mint(id, 'spec.pdf', 'application/pdf');
    const allowed = (ticket.body.details as { allowed?: { mimes?: string[] } } | undefined)
      ?.allowed;
    expect(allowed?.mimes?.sort()).toEqual(
      ['image/gif', 'image/jpeg', 'image/png', 'image/webp'].sort(),
    );
  });

  it('stores the bytes and answers with the file the room now holds', async () => {
    const id = await room();
    const ticket = await mint(id, 'screenshot.png', 'image/png');
    const stored = await put(ticket.body.uploadId as string, PNG);
    expect(stored.status).toBe(201);
    expect(stored.body).toMatchObject({
      conversationId: id,
      name: 'screenshot.png',
      mime: 'image/png',
      size: PNG.byteLength,
    });
    expect(stored.body.url).toBe(`/api/conversations/${id}/attachments/${stored.body.id}/download`);
  });

  it('burns the ticket, so the same capability cannot be replayed', async () => {
    const id = await room();
    const ticket = await mint(id, 'screenshot.png', 'image/png');
    await put(ticket.body.uploadId as string, PNG);
    const again = await put(ticket.body.uploadId as string, PNG);
    expect(again.status).toBe(404);
  });
});

describe('the message a file arrives on', () => {
  it('writes the file onto the message as the reference the model re-reads', async () => {
    const id = await room();
    const attachmentId = await upload(id);
    const res = await post(`/api/conversations/${id}/messages`, {
      content: 'what is in this picture',
      attachmentIds: [attachmentId],
    });
    expect([201, 202]).toContain(res.status);

    const [message] = await store.readMessages(id, 10);
    expect(message?.images).toEqual([
      {
        name: 'screenshot.png',
        mime: 'image/png',
        ref: `/api/conversations/${id}/attachments/${attachmentId}/download`,
      },
    ]);
  });

  it('refuses an id from another room, naming that id', async () => {
    const mine = await room();
    const theirs = await room();
    const foreign = await upload(theirs);
    const res = await post(`/api/conversations/${mine}/messages`, {
      content: 'here you go',
      attachmentIds: [foreign],
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string; code: string };
    expect(body.message).toContain(foreign);
    expect(body.code).toBe('CONVERSATION_ATTACHMENT_FOREIGN');
  });

  it('takes nothing in when one of several ids is foreign', async () => {
    const mine = await room();
    const theirs = await room();
    const ok = await upload(mine);
    const foreign = await upload(theirs);
    const res = await post(`/api/conversations/${mine}/messages`, {
      content: 'both of these',
      attachmentIds: [ok, foreign],
    });
    expect(res.status).toBe(409);
    expect(await store.readMessages(mine, 10)).toEqual([]);
  });

  it('refuses a message carrying neither text nor a file', async () => {
    const id = await room();
    const res = await post(`/api/conversations/${id}/messages`, { content: '   ' });
    expect(res.status).toBe(400);
  });

  it('takes a picture sent with no words at all', async () => {
    const id = await room();
    const attachmentId = await upload(id);
    const res = await post(`/api/conversations/${id}/messages`, {
      content: '',
      attachmentIds: [attachmentId],
    });
    expect([201, 202]).toContain(res.status);
    const [message] = await store.readMessages(id, 10);
    expect(message?.images).toHaveLength(1);
  });

  it('names such a room after the file, since there is no first line to name it after', async () => {
    const id = await room();
    const attachmentId = await upload(id);
    await post(`/api/conversations/${id}/messages`, { content: '', attachmentIds: [attachmentId] });
    expect((await store.getConversation(id))?.title).toBe('screenshot.png');
  });

  it('keeps two files in the order they were staged in', async () => {
    const id = await room();
    const first = await upload(id);
    const second = await upload(id);
    await post(`/api/conversations/${id}/messages`, {
      content: 'both of these',
      attachmentIds: [second, first],
    });
    const [message] = await store.readMessages(id, 10);
    expect(message?.images?.map((i) => i.ref)).toEqual([
      `/api/conversations/${id}/attachments/${second}/download`,
      `/api/conversations/${id}/attachments/${first}/download`,
    ]);
  });
});

describe('the door those bytes come back out of', () => {
  it("does not hand one room's file out through another room's door", async () => {
    const mine = await room();
    const theirs = await room();
    const attachmentId = await upload(theirs);
    const res = await app.request(
      `http://localhost/api/conversations/${mine}/attachments/${attachmentId}/download`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(404);
  });

  it('hands the bytes back to whoever may read the room', async () => {
    const id = await room();
    const attachmentId = await upload(id);
    const res = await app.request(
      `http://localhost/api/conversations/${id}/attachments/${attachmentId}/download`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it('hands them to nobody else', async () => {
    const id = await room();
    const attachmentId = await upload(id);
    const stranger = await createTestUser(harness.db);
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${stranger.id}`,
    );
    const res = await app.request(
      `http://localhost/api/conversations/${id}/attachments/${attachmentId}/download`,
      { headers: { authorization: `Bearer ${await signUserToken(stranger.id)}` } },
    );
    expect([403, 404]).toContain(res.status);
  });
});

describe('stopping a turn in a web conversation', () => {
  let stops: typeof import('../../src/assistant/conversation-stops.js');

  beforeAll(async () => {
    stops = await import('../../src/assistant/conversation-stops.js');
  });

  let token: string;
  let conversationId: string;

  beforeEach(async () => {
    await truncateAll(harness.db);
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'member',
    });
    token = await signUserToken(user.id);
    const opened = await store.openConversation({
      adapter: 'web',
      externalId: `web ${randomUUID()}`,
      shape: 'direct',
      projectId: project.id,
    });
    conversationId = opened.id;
    await participants.addPerson({ conversationId, userId: user.id });
  });

  const stop = () =>
    app.request(`http://localhost/api/conversations/${conversationId}/stop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

  it('refuses by name where the room is answering nothing', async () => {
    const res = await stop();
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string; code: string };
    expect(body.code).toBe('CONVERSATION_NOTHING_RUNNING');
    expect(body.message).toContain('nothing to stop');
  });

  it('ends the turn this core is holding open, and says it did', async () => {
    const held = stops.registerTurnStop(conversationId);
    try {
      const res = await stop();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ conversationId, stopped: 1 });
      expect(held.signal.aborted).toBe(true);
      expect(held.signal.reason).toBe('stopped-by-a-person');
    } finally {
      held.release();
    }
  });

  it('refuses again once that turn is over', async () => {
    stops.registerTurnStop(conversationId).release();
    expect((await stop()).status).toBe(409);
  });
});
