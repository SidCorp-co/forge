// ISS-876 regression coverage: a `note` write whose text is near-identical to
// an existing row, under a sourceRef that does not yet exist. The absorb this
// replaced redirected such a write onto the OTHER row, overwriting text no
// caller had named, and handed back a `supersededSnapshotRef` pointing at an
// archived row that no read surface would return.

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

function deterministicVector(seed: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  v[Math.abs(h) % DIM] = 1;
  return v;
}

describe('memory near-duplicate writes (ISS-876)', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  let embeddingsMod: typeof import('../../src/embeddings/index.js');

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';
    process.env.EMBEDDINGS_BASE_URL ??= 'https://stub.invalid';
    process.env.EMBEDDINGS_API_KEY ??= 'stub-key';

    const { memoryWriteRoutes } = await import('../../src/memory/write-routes.js');
    const { memoryListRoutes } = await import('../../src/memory/list-routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    const jwtMod = await import('../../src/auth/jwt.js');
    embeddingsMod = await import('../../src/embeddings/index.js');
    signUserToken = jwtMod.signUserToken;

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/memory', memoryWriteRoutes);
    app.route('/api/memory', memoryListRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seedMember(): Promise<{ projectId: string; token: string }> {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'admin',
    });
    const token = await signUserToken(user.id);
    return { projectId: project.id, token };
  }

  // cm:guard every text embeds to ONE vector here, so the probe scores a perfect 1.0 — the strongest form of the condition that used to absorb the write; a content-dependent stub would score below the threshold and the test would pass without ever exercising the rule
  function stubOneVectorForEverything() {
    const one = deterministicVector('the-same-topic');
    const fake = {
      embed: vi.fn(async () => one),
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => one)),
      resetBreaker: () => undefined,
    };
    embeddingsMod.resetEmbeddingsClient(
      fake as unknown as InstanceType<typeof embeddingsMod.EmbeddingsClient>,
    );
  }

  async function write(token: string, projectId: string, sourceRef: string, textContent: string) {
    return app.request('/api/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId, source: 'note', sourceRef, textContent }),
    });
  }

  // cm:guard ISS-876: a write under an unused sourceRef must CREATE that ref and leave every other row's text byte-identical — the absorb this replaced overwrote the 08-19 summary with the 08-29 one on forge-dev, and the caller could not read the loss back
  it('creates the ref asked for and leaves the older note recoverable in full', async () => {
    const { projectId, token } = await seedMember();
    stubOneVectorForEverything();

    const older = '## Dream Run — 2026-08-19\n\nSix bullets, the 08-19 findings.';
    const newer = '## Dream Run — 2026-08-29\n\nSix bullets, the 08-29 findings.';
    expect((await write(token, projectId, 'dream-daily-review-2026-08-19', older)).status).toBe(
      201,
    );

    const res = await write(token, projectId, 'dream-daily-review-2026-08-29', newer);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { nearDuplicateOf?: string; dedupeScore?: number };

    const listed = await app.request(
      `/api/memory?projectId=${projectId}&source=note&limit=50&offset=0`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const rows = (await listed.json()) as Array<{ sourceRef: string; textContent: string }>;
    const byRef = new Map(rows.map((r) => [r.sourceRef, r.textContent]));

    expect(byRef.get('dream-daily-review-2026-08-29')).toBe(newer);
    expect(byRef.get('dream-daily-review-2026-08-19')).toBe(older);
    expect(rows).toHaveLength(2);
    expect(body.nearDuplicateOf).toBe('dream-daily-review-2026-08-19');
    expect(body.dedupeScore).toBeGreaterThan(0.85);
  });

  // cm:guard ISS-876: the rows the old absorb archived are the ONLY surviving copy of the notes it destroyed — if includeArchived stops reaching them, that text is unrecoverable through every read surface Forge exposes
  it('recovers text that survives only in an archived row, flagged as archived', async () => {
    const { projectId, token } = await seedMember();
    stubOneVectorForEverything();
    await write(token, projectId, 'live-note', 'the live wording');
    const lost = 'the 08-19 summary, archived by the old dedup absorb';
    await harness.db.execute(sql`
    INSERT INTO memories (project_id, source, source_ref, text_content, metadata, archived_at)
    VALUES (${projectId}, 'note', 'live-note__superseded-1788019630132', ${lost},
            '{}'::jsonb, now())
  `);

    const hidden = await app.request(
      `/api/memory?projectId=${projectId}&source=note&limit=50&offset=0`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const liveRows = (await hidden.json()) as Array<{ sourceRef: string }>;
    expect(liveRows.map((r) => r.sourceRef)).toEqual(['live-note']);

    const recovered = await app.request(
      `/api/memory?projectId=${projectId}&source=note&limit=50&offset=0&includeArchived=true`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const allRows = (await recovered.json()) as Array<{
      sourceRef: string;
      textContent: string;
      archivedAt: string | null;
    }>;
    const snapshot = allRows.find((r) => r.sourceRef.includes('__superseded-'));
    expect(snapshot?.textContent).toBe(lost);
    expect(snapshot?.archivedAt).not.toBeNull();
    expect(allRows.find((r) => r.sourceRef === 'live-note')?.archivedAt).toBeNull();
  });

  it('reports no near-duplicate when the caller re-writes its own ref', async () => {
    const { projectId, token } = await seedMember();
    stubOneVectorForEverything();

    await write(token, projectId, 'same-ref', 'first wording');
    const res = await write(token, projectId, 'same-ref', 'second wording');

    const body = (await res.json()) as { nearDuplicateOf?: string };
    expect(body.nearDuplicateOf).toBeUndefined();

    const rows = await harness.db.execute(sql`
    SELECT text_content FROM memories
    WHERE project_id = ${projectId} AND source_ref = 'same-ref'
  `);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text_content).toBe('second wording');
  });
});
