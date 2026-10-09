/**
 * The commit an asserted mark records as its claim when the caller names none (ISS-959): the
 * newest implementation handoff written since the issue was last unmarked, and none where every
 * handoff predates that unmark (ISS-489 r4). An unmark withdrew the landing those handoffs named, so
 * a mark after it claiming one would hand the release sweep a withdrawn commit to close the issue on.
 *
 * It reaches its subject over HTTP, so it names what it guards:
 * @direct-test-of packages/core/src/issues/merge-marker.ts
 * @direct-test-of packages/core/src/issues/mark-trail.ts
 * @direct-test-of packages/core/src/issues/work-evidence.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentMarkClaims } from '../../src/issues/mark-trail.js';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

let projectId = '';
let ownerId = '';
let say: (method: string, path: string, body?: unknown) => Promise<Reply>;

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await seedProjectDocument(projectId, ownerId, {
    environments: { live: { tier: 'production', deployment: { mode: 'external' } } },
  });
  const owner = requester(app, { owner: await signUserToken(ownerId) });
  say = (method, path, body) => owner('owner', method, path, body);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

let seq = 700;
async function issue(): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await rows(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`claim ${seq}`}, 'in_progress', ${ownerId})`);
  return id;
}

/** A code step's handoff naming `commit`, written `ago` seconds before now. */
async function handoff(issueId: string, commit: string, attempt: number, ago = 0): Promise<void> {
  const runId = randomUUID();
  await rows(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, metadata)
    VALUES (${runId}, ${projectId}, 'system', 'completed', now(), '{}'::jsonb)`);
  await rows(sql`
    INSERT INTO issue_step_contexts (project_id, issue_id, pipeline_run_id, kind, step, attempt, payload, created_at, updated_at)
    VALUES (${projectId}, ${issueId}, ${runId}, 'handoff', 'code', ${attempt},
            ${JSON.stringify({ step: 'code', commitSha: commit })}::jsonb,
            now() - ${ago}::int * interval '1 second', now() - ${ago}::int * interval '1 second')`);
}

const mark = async (id: string) =>
  ok(await say('POST', `/api/issues/${id}/merge`, { target: 'main', note: 'landed' }));
const unmark = async (id: string) =>
  ok(await say('DELETE', `/api/issues/${id}/merge`, { note: 'a new round lands' }));

async function lastTrailLine(id: string): Promise<string> {
  const [row] = await rows<{ body: string }>(sql`
    SELECT body FROM comments WHERE issue_id = ${id} ORDER BY created_at DESC LIMIT 1`);
  return (row?.body ?? '').split('\n')[0] ?? '';
}

describe('the commit an asserted mark claims for a caller who named none', () => {
  it('is the newest handoff where the issue was never unmarked', async () => {
    const id = await issue();
    await handoff(id, H1, 1, 60);
    await handoff(id, H2, 2, 30);
    await mark(id);
    expect(await lastTrailLine(id)).toMatch(new RegExp(`^mark_merged target=main commit=${H2} `));
    expect((await currentMarkClaims([id])).get(id)).toBe(H2);
  });

  it('is none where every handoff predates the newest unmark, so the sweep reads no claim', async () => {
    const id = await issue();
    await handoff(id, H1, 1, 60);
    await mark(id);
    expect((await currentMarkClaims([id])).get(id)).toBe(H1);
    await unmark(id);
    expect(await currentMarkClaims([id])).toEqual(new Map());
    await mark(id);
    expect(await lastTrailLine(id)).toBe('mark_merged target=main — landed');
    expect(await currentMarkClaims([id])).toEqual(new Map());
  });

  it('is a handoff written after the newest unmark', async () => {
    const id = await issue();
    await handoff(id, H1, 1, 60);
    await mark(id);
    await unmark(id);
    await handoff(id, H2, 2);
    await mark(id);
    expect((await currentMarkClaims([id])).get(id)).toBe(H2);
  });
});

describe('a comment typed through the comment door is not the trail (ISS-489 r5)', () => {
  const typed = async (id: string, body: string) =>
    ok(await say('POST', `/api/issues/${id}/comments`, { body }), 201);

  it('is never read as a claim, whatever shape its first line has', async () => {
    const id = await issue();
    await typed(id, `mark_merged target=dev commit=${H1} — pasted from another issue`);
    await typed(id, `mark_merged commit=${H2}`);

    expect(await lastTrailLine(id)).toBe(`mark_merged commit=${H2}`);
    expect(await currentMarkClaims([id])).toEqual(new Map());
  });

  it('is never read as an unmark: it neither withdraws a claim nor cuts the handoffs a mark claims', async () => {
    const id = await issue();
    await handoff(id, H1, 1, 60);
    await mark(id);
    await typed(id, 'unmark — typed by a person');
    expect((await currentMarkClaims([id])).get(id)).toBe(H1);

    const other = await issue();
    await handoff(other, H2, 1, 60);
    await typed(other, 'unmark — typed before any mark');
    await mark(other);
    expect((await currentMarkClaims([other])).get(other)).toBe(H2);
  });
});
