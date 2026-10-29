/**
 * A message the screen refuses is refused by name at every door that takes one, never a bare 500.
 * The shared error handler maps `MessageRefusedError` (`middleware/error.ts`), so a route that
 * forgets to is still a named 422: found by the release judge J7 on ISS-439, where
 * `POST /api/issues/:id/transition` answered INTERNAL_ERROR to a reason the comment route refused
 * as MESSAGE_REFUSED.
 *
 * @direct-test-of packages/core/src/issues/transition-reason.ts
 * @direct-test-of packages/core/src/comments/notices.ts
 * @direct-test-of packages/core/src/comments/screen.ts
 * @direct-test-of packages/core/src/comments/routes.ts
 * @direct-test-of packages/core/src/issues/record-events/routes.ts
 * @direct-test-of packages/core/src/issues/record-events/write.ts
 * @direct-test-of packages/core/src/issues/merge-marker.ts
 * @direct-test-of packages/core/src/issues/criteria/verdict-input.ts
 * @direct-test-of packages/core/src/issues/criteria/verdict-record.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { type ApiResponse, api, patToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

/** Wording the secret scrubber redacts: a bearer token, told from prose by its shape. */
const SCRUBBED = 'The probe sent Bearer 4f9c2a7e1b8d3c6f0a5e as its header.';
const LANDED = 'e65b54a38943ea78135b2e1c61fab9dfa5881c8e';

let projectId: string;
let ownerId: string;
let token: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  // the screen reads an agent's message, so the writer is an agent with a token of its own
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agent, 'admin');
  token = await patToken(agent, [projectId]);
});

async function issueAt(status: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, 1, 'scrubbed reason', ${status}, ${ownerId})
  `);
  return id;
}

async function statusOf(id: string): Promise<string> {
  const [row] = await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`);
  return String(row?.status);
}

/** The rule a `MESSAGE_REFUSED` names in its sentence, read the way a caller reads it. */
function ruleOf(res: ApiResponse): string | null {
  return /\(rule ([\w-]+);/.exec(String(res.body.detail))?.[1] ?? null;
}

/** Where in the request the refusal says the refused text sat. */
function pathOf(res: ApiResponse): string | undefined {
  const error = res.body.error as { refusals?: { path: string }[] } | undefined;
  return error?.refusals?.[0]?.path;
}

describe('a message the screen refuses', () => {
  it('is refused by name as a transition reason, and the issue does not move', async () => {
    const id = await issueAt('in_progress');
    const res = await api(token, 'POST', `/api/issues/${id}/transition`, {
      toStatus: 'on_hold',
      reason: SCRUBBED,
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MESSAGE_REFUSED');
    expect(ruleOf(res)).toBe('no-redacted-secret');
    expect(pathOf(res)).toBe('/reason');
    expect(await statusOf(id)).toBe('in_progress');
  });

  it('is refused by name as a merge mark note, and no mark is written', async () => {
    await seedProjectDocument(projectId, ownerId, { environments: {}, defaultBranch: 'dev' });
    const id = await issueAt('in_progress');
    // a branch is the work evidence an agent's mark needs before it reads the note
    const worked = await api(token, 'PATCH', `/api/issues/${id}`, {
      workState: { step: 'plan', branch: 'scrubbed-note', headSha: LANDED },
    });
    expect(worked.status, JSON.stringify(worked.body)).toBe(200);
    const res = await api(token, 'POST', `/api/issues/${id}/merge`, {
      target: 'dev',
      commit: LANDED,
      note: SCRUBBED,
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MESSAGE_REFUSED');
    expect(ruleOf(res)).toBe('no-redacted-secret');
    expect(pathOf(res)).toBe('/note');
    const [row] = await rows<{ marks: number }>(
      sql`SELECT count(*)::int AS marks FROM issues WHERE id = ${id} AND merged_at IS NOT NULL`,
    );
    expect(row?.marks).toBe(0);
  });

  it('is refused under the same code and rule as a comment', async () => {
    const id = await issueAt('in_progress');
    const res = await api(token, 'POST', `/api/issues/${id}/comments`, {
      body: SCRUBBED,
      intent: 'note',
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MESSAGE_REFUSED');
    expect(ruleOf(res)).toBe('no-redacted-secret');
    expect(pathOf(res)).toBe('/body');
  });

  it('is refused by name as a verdict reason, and no verdict is written', async () => {
    const id = await issueAt('in_progress');
    const criteria = await api(token, 'PATCH', `/api/issues/${id}`, {
      acceptanceCriteria: '1. A reminder reaches the nurse.',
    });
    expect(criteria.status, JSON.stringify(criteria.body)).toBe(200);
    const res = await api(token, 'POST', `/api/issues/${id}/verdicts`, {
      criterion: 1,
      verdict: 'skipped',
      reason: SCRUBBED,
    });

    expect(res.status).toBe(422);
    const error = res.body.error as { refusals?: { code: string; path: string }[] } | undefined;
    expect(error?.refusals?.map((r) => [r.code, r.path])).toEqual([['VERDICT_SECRET', '/reason']]);
    const [row] = await rows<{ verdicts: number }>(
      sql`SELECT count(*)::int AS verdicts FROM criterion_verdicts WHERE issue_id = ${id}`,
    );
    expect(row?.verdicts).toBe(0);
  });

  it('is refused by name as a record event field, at the fields it sent', async () => {
    const id = await issueAt('in_progress');
    const res = await api(token, 'POST', `/api/issues/${id}/events`, {
      kind: 'decision',
      contract: 1,
      fields: [
        { key: 'decision', value: 'x'.repeat(401) },
        { key: 'why', value: 'one field over its budget' },
      ],
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MESSAGE_REFUSED');
    expect(ruleOf(res)).toBe('field-budget');
    expect(pathOf(res)).toBe('/fields');
  });
});

// ISS-757: a header named in prose says where a credential travels, which is what a message should
// say instead of the credential; only a credential-shaped value after the header or its scheme word
// is refused.
describe('a credential header in a message', () => {
  const NAMED = 'The JWT goes in the Authorization: Bearer header, read at src/auth/guard.ts:42.';
  const COOKIE = 'The Cookie: is set by the browser on sign-in, read at src/auth/session.ts:9.';
  const JWT =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const OPAQUE = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

  it.each([NAMED, COOKIE, 'Set X-Api-Key: unset in this environment, see src/env.ts:3.'])(
    'is written as a comment where it names the header only: %s',
    async (body) => {
      const id = await issueAt('in_progress');
      const res = await api(token, 'POST', `/api/issues/${id}/comments`, { body, intent: 'note' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    },
  );

  it.each([
    `Send Authorization: Bearer ${JWT} from src/auth/guard.ts:42.`,
    `Send X-Api-Key: ${OPAQUE} from src/env.ts:3.`,
    'Cookie: theme=dark; sid=abcdef123456',
  ])('is refused as a comment where a value follows: %s', async (body) => {
    const id = await issueAt('in_progress');
    const res = await api(token, 'POST', `/api/issues/${id}/comments`, { body, intent: 'note' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MESSAGE_REFUSED');
    expect(ruleOf(res)).toBe('no-redacted-secret');
    expect(JSON.stringify(res.body)).not.toContain(OPAQUE);
  });

  it('is written as a verdict reason naming the header, and refused carrying its value', async () => {
    const id = await issueAt('in_progress');
    const criteria = await api(token, 'PATCH', `/api/issues/${id}`, {
      acceptanceCriteria: '1. A reminder reaches the nurse.',
    });
    expect(criteria.status, JSON.stringify(criteria.body)).toBe(200);
    const named = await api(token, 'POST', `/api/issues/${id}/verdicts`, {
      criterion: 1,
      verdict: 'skipped',
      reason: NAMED,
    });
    expect(named.status, JSON.stringify(named.body)).toBe(201);

    const carried = await api(token, 'POST', `/api/issues/${id}/verdicts`, {
      criterion: 1,
      verdict: 'skipped',
      reason: `The probe sent X-Api-Key: ${OPAQUE} to the route.`,
    });
    expect(carried.status).toBe(422);
    const error = carried.body.error as
      | { refusals?: { code: string; detail: string }[] }
      | undefined;
    expect(error?.refusals?.map((r) => r.code)).toEqual(['VERDICT_SECRET']);
    const detail = String(error?.refusals?.[0]?.detail);
    expect(JSON.stringify(carried.body)).not.toContain(OPAQUE);
    expect(detail).not.toContain('credential entry');
    expect(detail).toContain('say where it is kept, never its value');
  });
});
