// ISS-1034 — a person's own notes against a real Postgres: `GET /api/memory/mine`
// answers with the rows written on the caller's behalf and no one else's, the
// DELETE refuses another author's row in the same room by name, and a removed
// row is gone from `POST /api/memory/search`, which is what `forge_memory.search` reads.
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const DIM = 1536;
const ENV_DEFAULTS: Record<string, string> = {
  JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef-123456',
  DEVICE_TOKEN_PEPPER: 'test-device-pepper-at-least-32-chars-long-aa',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_USER: 'test',
  SMTP_PASS: 'test',
  SMTP_FROM: 'test@example.com',
  APP_BASE_URL: 'http://localhost:3000',
  CORS_ORIGINS: 'http://localhost:3000',
  NODE_ENV: 'test',
  EMBEDDINGS_BASE_URL: 'https://stub.invalid',
  EMBEDDINGS_API_KEY: 'stub-key',
};
const HOT = (() => {
  const v = new Array<number>(DIM).fill(0);
  v[7] = 1;
  return v;
})();

describe('a person’s own notes (ISS-1034 criteria 28–31)', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  let embeddingsMod: typeof import('../../src/embeddings/index.js');

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    for (const [key, value] of Object.entries(ENV_DEFAULTS)) process.env[key] ??= value;
    const { memoryMineRoutes } = await import('../../src/memory/mine-routes.js');
    const { memorySearchRoutes } = await import('../../src/memory/search-routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;
    embeddingsMod = await import('../../src/embeddings/index.js');
    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/memory', memorySearchRoutes);
    app.route('/api/memory', memoryMineRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const fake = {
      embed: vi.fn(async () => HOT),
      embedBatch: vi.fn(async () => [HOT]),
      resetBreaker: () => undefined,
    };
    embeddingsMod.resetEmbeddingsClient(
      fake as unknown as InstanceType<
        typeof import('../../src/embeddings/index.js').EmbeddingsClient
      >,
    );
  });

  async function member(projectId: string | null) {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = projectId ?? (await createTestProject(harness.db, user.id)).id;
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project,
      role: 'admin',
    });
    return { id: user.id, projectId: project, token: await signUserToken(user.id) };
  }

  async function note(
    projectId: string,
    conversationId: string,
    authorUserId: string,
    text: string,
    source = 'note',
  ): Promise<string> {
    const id = randomUUID();
    const metadata = JSON.stringify({ conversationId, authorUserId, handleUserId: 'handle-1' });
    await harness.db.execute(sql`
      INSERT INTO memories (id, project_id, source, source_ref, text_content, embedding, metadata)
      VALUES (${id}, ${projectId}, ${source}, ${`conversation:${conversationId}:${id}`}, ${text}, ${`[${HOT.join(',')}]`}::vector, ${metadata}::jsonb)
    `);
    return id;
  }

  const mine = async (token: string) => {
    const res = await app.request('/api/memory/mine', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: Array<{ id: string }> }).items.map((i) => i.id).sort();
  };
  const remove = (token: string, id: string) =>
    app.request(`/api/memory/mine/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
  const searchTexts = async (token: string, projectId: string) => {
    const res = await app.request('/api/memory/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId, query: 'thursday' }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { hits: Array<{ text: string }> }).hits.map((h) => h.text).sort();
  };

  it('lists only the caller’s notes, in a room two people share', async () => {
    const alice = await member(null);
    const bob = await member(alice.projectId);
    const room = randomUUID();
    const a1 = await note(alice.projectId, room, alice.id, 'alice: deploys on thursday');
    const a2 = await note(alice.projectId, room, alice.id, 'alice: staging is shared');
    const b1 = await note(alice.projectId, room, bob.id, 'bob: thursday standup moved');
    await note(alice.projectId, room, alice.id, 'alice knowledge row', 'knowledge');

    expect(await mine(alice.token)).toEqual([a1, a2].sort());
    expect(await mine(bob.token)).toEqual([b1]);
  });

  it('refuses another author’s row by name and leaves it standing', async () => {
    const alice = await member(null);
    const bob = await member(alice.projectId);
    const room = randomUUID();
    const b1 = await note(alice.projectId, room, bob.id, 'bob: thursday standup moved');

    const res = await remove(alice.token, b1);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
    expect(await mine(bob.token)).toEqual([b1]);
  });

  it('removes the caller’s row, and search no longer returns it', async () => {
    const alice = await member(null);
    const room = randomUUID();
    const a1 = await note(alice.projectId, room, alice.id, 'alice: deploys on thursday');
    const a2 = await note(alice.projectId, room, alice.id, 'alice: thursday is quiet');
    expect(await searchTexts(alice.token, alice.projectId)).toEqual(
      ['alice: deploys on thursday', 'alice: thursday is quiet'].sort(),
    );

    expect((await remove(alice.token, a1)).status).toBe(204);
    expect(await mine(alice.token)).toEqual([a2]);
    expect(await searchTexts(alice.token, alice.projectId)).toEqual(['alice: thursday is quiet']);
    expect((await remove(alice.token, a1)).status).toBe(404);
  });
});
