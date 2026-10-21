/**
 * ISS-1228 round 27 — two things an open page was never told. A comment posted by anyone else never
 * appeared on an open issue page (judge-85, criterion 268): the web re-reads an issue's comments on
 * `comment.*` frames, and core sent none. And a project deleted while its pages were open kept its
 * live count in their rail (criterion 267). Both doors now tell the project's room, with ids only.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: Hono<AppVars>;
let ownerId: string;
let projectId: string;
let issueId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  ({ app } = (await import('../../src/index.js')) as unknown as { app: Hono<AppVars> });
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 7, 'Scratch comment target', 'open', ${ownerId})
  `);
});

async function asOwner(path: string, init: { method: string; body?: unknown }): Promise<Response> {
  const { signUserToken } = await import('../../src/auth/jwt.js');
  return app.request(path, {
    method: init.method,
    headers: {
      authorization: `Bearer ${await signUserToken(ownerId)}`,
      'content-type': 'application/json',
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function framesTo(room: string, act: () => Promise<void>): Promise<unknown[]> {
  const { roomManager } = await import('../../src/ws/server.js');
  const publish = vi.spyOn(roomManager, 'publish');
  try {
    await act();
    return publish.mock.calls.filter(([to]) => to === room).map(([, frame]) => frame);
  } finally {
    publish.mockRestore();
  }
}

describe('an open page hears of what changed it (criteria 267 and 268)', () => {
  it('tells the project room a comment was posted, edited and deleted, naming the issue and nothing of the body', async () => {
    const { projectRoom } = await import('../../src/ws/rooms.js');
    let commentId = '';
    const frames = await framesTo(projectRoom(projectId), async () => {
      const posted = await asOwner(`/api/issues/${issueId}/comments`, {
        method: 'POST',
        body: { body: 'The address is kept after the edit.' },
      });
      expect(posted.status).toBe(201);
      commentId = ((await posted.json()) as { id: string }).id;
      const edited = await asOwner(`/api/comments/${commentId}`, {
        method: 'PATCH',
        body: { body: 'The address is kept after the second edit.' },
      });
      expect(edited.status).toBe(200);
      const deleted = await asOwner(`/api/comments/${commentId}`, { method: 'DELETE' });
      expect(deleted.status).toBe(204);
    });

    const ids = { issueId, projectId, commentId, actorId: ownerId };
    const commentFrames = frames.filter((f) =>
      (f as { event: string }).event.startsWith('comment.'),
    );
    expect(commentFrames).toEqual([
      { event: 'comment.created', data: ids },
      { event: 'comment.updated', data: ids },
      { event: 'comment.deleted', data: ids },
    ]);
    expect(JSON.stringify(commentFrames)).not.toMatch(/address/);
  });

  it('tells the project room the project was deleted', async () => {
    const { projectRoom } = await import('../../src/ws/rooms.js');
    const frames = await framesTo(projectRoom(projectId), async () => {
      const res = await asOwner(`/api/projects/${projectId}`, { method: 'DELETE' });
      expect(res.status).toBe(204);
    });
    expect(frames).toContainEqual({ event: 'project.deleted', data: { projectId } });
  });

  it('tells nobody a project was deleted when the delete is refused', async () => {
    const { projectRoom } = await import('../../src/ws/rooms.js');
    const outsiderId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
    const { signUserToken } = await import('../../src/auth/jwt.js');
    const frames = await framesTo(projectRoom(projectId), async () => {
      const res = await app.request(`/api/projects/${projectId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${await signUserToken(outsiderId)}` },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
    expect(frames).not.toContainEqual(expect.objectContaining({ event: 'project.deleted' }));
  });
});
