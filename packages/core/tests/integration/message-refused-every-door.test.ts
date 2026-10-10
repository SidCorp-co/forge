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

/** Wording the secret scrubber redacts: `Bearer` and a word of eight letters or more. */
const SCRUBBED = 'The door admits a Bearer credential through an aliased import.';
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

  it('is refused by name as a record event field, at the fields it sent', async () => {
    const id = await issueAt('in_progress');
    const res = await api(token, 'POST', `/api/issues/${id}/events`, {
      kind: 'decision',
      contract: 1,
      fields: [
        { key: 'decision', value: 'x'.repeat(401) },
        { key: 'reason', value: 'one field over its budget' },
      ],
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MESSAGE_REFUSED');
    expect(ruleOf(res)).toBe('field-budget');
    expect(pathOf(res)).toBe('/fields');
  });
});
