/**
 * The merge mark's commit and its standing-mark refusal, over HTTP.
 *
 * ISS-575 (REQ-71): on a project whose repository core cannot read, an agent's mark naming a commit
 * is refused COMMIT_UNVERIFIED until the work's branch is recorded, and the refusal steered the run
 * to a mark carrying the commit only in its note, which claims none, so the release sweep held the
 * issue SHIPPED_EARLIER_NO_COMMIT. The refusal now names the asserted route: the branch, then the
 * whole sha in `commit`. A sha shorter or longer than the 40 characters the claim reader takes was
 * stamped `merged` and its claim silently dropped; it is refused COMMIT_NOT_WHOLE and marks nothing.
 *
 * ISS-592 (REQ-68): MARK_ALREADY_STANDS said to `unmark` first and named only the UI rail, so an
 * agent guessed a route that does not exist. Every such refusal names `DELETE /api/issues/:id/merge`.
 *
 * @direct-test-of packages/core/src/issues/merge-marker.ts
 * @direct-test-of packages/core/src/issues/commit-landing.ts
 * @direct-test-of packages/core/src/issues/landing-evidence.ts
 * @direct-test-of packages/core/src/issues/mark-trail.ts
 * @direct-test-of packages/core/src/issues/work-evidence.ts
 * @direct-test-of packages/core/src/guides/issue-flow-guide.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { standingArtifactsRefusal } from '../../src/issues/landing-evidence.js';
import { currentMarkClaims } from '../../src/issues/mark-trail.js';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { createTestDevice, createTestProject, createTestUser, rows } from '../helpers/factories.js';
import { boxToken } from '../helpers/preview-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const WHOLE = `${'c0ffee'.repeat(6)}abcd`;
const OTHER = 'b'.repeat(40);
const DELETE_ROUTE = 'DELETE /api/issues/:id/merge';
const LIVE = { live: { tier: 'production' as const, deployment: { mode: 'external' as const } } };

let gitProject = '';
let landingProject = '';
let ownerId = '';
let box: (method: string, path: string, body?: unknown) => Promise<Reply>;

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  gitProject = (await createTestProject(ownerId)).id;
  await seedProjectDocument(gitProject, ownerId, { environments: LIVE, defaultBranch: 'dev' });
  landingProject = (await createTestProject(ownerId)).id;
  await seedProjectDocument(landingProject, ownerId, {
    environments: LIVE,
    source: { type: 'none' } as never,
  });
  const device = await createTestDevice(ownerId);
  const call = requester(app, { box: await boxToken(ownerId, device) });
  box = (method, path, body) => call('box', method, path, body);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

let seq = 900;
async function issue(projectId: string): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await rows(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`mark ${seq}`}, 'in_progress', ${ownerId})`);
  return id;
}

/** The work's branch on the issue, as a run records it before it marks. */
async function recordBranch(id: string, branch: string): Promise<void> {
  ok(
    await box('PATCH', `/api/issues/${id}`, {
      workState: { step: 'plan', branch, headSha: WHOLE },
    }),
  );
}

async function mergedAt(id: string): Promise<unknown> {
  const [row] = await rows<{ merged_at: unknown }>(sql`
    SELECT merged_at FROM issues WHERE id = ${id}`);
  return row?.merged_at ?? null;
}

/** The one refusal a 422 carries, as code, path and detail. */
function refusalOf(r: Reply): { code: string; path: string; detail: string } {
  expect(r.status, JSON.stringify(r.json)).toBe(422);
  const [first] = r.json.error?.refusals ?? [];
  return { code: first?.code, path: first?.path, detail: first?.detail ?? '' };
}

describe('an asserted mark on a repository core cannot read (ISS-575)', () => {
  it('is refused COMMIT_UNVERIFIED naming the branch and the whole sha in `commit`, never a note', async () => {
    const id = await issue(gitProject);
    const r = await box('POST', `/api/issues/${id}/merge`, { target: 'dev', commit: WHOLE });
    const refused = refusalOf(r);
    expect(refused.code).toBe('COMMIT_UNVERIFIED');
    expect(refused.path).toBe('/commit');
    expect(refused.detail).toContain('workState.branch');
    expect(refused.detail).toContain('`commit`');
    expect(refused.detail).toContain('the whole 40-character sha');
    expect(refused.detail).not.toMatch(/a note naming this commit/);
    expect(await mergedAt(id)).toBeNull();
  });

  it('is refused NO_WORK_EVIDENCE naming the merge route and its `commit`, never an action core has not', async () => {
    const id = await issue(landingProject);
    const refused = refusalOf(
      await box('POST', `/api/issues/${id}/merge`, { landing: 'https://shop.example.test/x' }),
    );
    expect(refused.code).toBe('NO_WORK_EVIDENCE');
    expect(refused.detail).toContain('`POST /api/issues/:id/merge` carrying `commit`');
    expect(refused.detail).not.toContain('mark_merged');
  });

  it('records the whole commit as the claim once the branch is recorded, with its target', async () => {
    const id = await issue(gitProject);
    await recordBranch(id, 'fix/mark-asserted');
    const marked = ok(
      await box('POST', `/api/issues/${id}/merge`, {
        target: 'dev',
        commit: WHOLE,
        note: 'landed',
      }),
    );
    expect(marked.action).toBe('merged');
    expect(marked.mark).toBe('asserted');
    expect(await mergedAt(id)).not.toBeNull();
    expect((await currentMarkClaims([id])).get(id)).toBe(WHOLE);
    const [trail] = await rows<{ payload: { target: string; commit: string } }>(sql`
      SELECT payload FROM activity_log WHERE issue_id = ${id} AND action = 'issue.mergeMarked'`);
    expect(trail?.payload).toMatchObject({ target: 'dev', commit: WHOLE });
  });

  it.each([
    ['seven characters', WHOLE.slice(0, 7)],
    ['39 characters', WHOLE.slice(0, 39)],
    ['41 characters', `${WHOLE}a`],
    ['64 characters', 'a'.repeat(64)],
  ])('refuses a commit of %s by name and marks nothing', async (_, commit) => {
    const id = await issue(gitProject);
    await recordBranch(id, 'fix/mark-short');
    const refused = refusalOf(
      await box('POST', `/api/issues/${id}/merge`, { target: 'dev', commit }),
    );
    expect(refused.code).toBe('COMMIT_NOT_WHOLE');
    expect(refused.path).toBe('/commit');
    expect(refused.detail).toContain(commit);
    expect(refused.detail).toContain('40');
    expect(await mergedAt(id)).toBeNull();
    expect(await currentMarkClaims([id])).toEqual(new Map());
  });
});

describe('the delivery guide teaches the asserted mark with its commit (ISS-575)', () => {
  it('directs the whole sha in `commit` after the branch, never a commit only in the note', async () => {
    const r = await box('GET', '/api/guides/issue-flow.md');
    expect(r.status).toBe(200);
    const guide = String(r.json?.raw ?? '').replace(/\s+/g, ' ');
    const land = guide.slice(guide.indexOf('### 6. Land, mark, move'));
    expect(land).toContain("record the work's branch in `workState.branch` first");
    expect(land).toContain('the commit in `commit`, never only in `note`');
    expect(land).toContain('`COMMIT_NOT_WHOLE`');
    expect(land).toContain('`DELETE /api/issues/:id/merge` clears it');
    expect(land).not.toMatch(/a `note` naming the commit/);
  });
});

describe('a re-mark refused MARK_ALREADY_STANDS names the route that clears the mark (ISS-592)', () => {
  it('names it where the landing sent is not the one that stands', async () => {
    const id = await issue(landingProject);
    await recordBranch(id, 'fix/mark-landing');
    ok(await box('POST', `/api/issues/${id}/merge`, { landing: 'https://shop.example.test/a' }));
    const refused = refusalOf(
      await box('POST', `/api/issues/${id}/merge`, { landing: 'https://shop.example.test/b' }),
    );
    expect(refused.code).toBe('MARK_ALREADY_STANDS');
    expect(refused.detail).toContain(DELETE_ROUTE);
    ok(await box('DELETE', `/api/issues/${id}/merge`, {}));
    ok(await box('POST', `/api/issues/${id}/merge`, { landing: 'https://shop.example.test/b' }));
  });

  it('names it where the paths sent were read at another commit than the ones that stand', async () => {
    const id = await issue(gitProject);
    await recordBranch(id, 'fix/mark-paths');
    const paths = (commit: string) => ({
      commit,
      changes: [{ path: 'packages/core/src/a.ts', change: 'changed' }],
    });
    ok(
      await box('POST', `/api/issues/${id}/merge`, {
        target: 'dev',
        commit: WHOLE,
        changedPaths: paths(WHOLE),
      }),
    );
    const refused = refusalOf(
      await box('POST', `/api/issues/${id}/merge`, {
        target: 'dev',
        commit: OTHER,
        changedPaths: paths(OTHER),
      }),
    );
    expect(refused.code).toBe('MARK_ALREADY_STANDS');
    expect(refused.detail).toContain(DELETE_ROUTE);
  });

  it('names it where the artifacts sent are not the ones that stand', () => {
    const held = [{ surface: 'storefront', ref: 'theme/a', change: 'modified' }] as never;
    const sent = [{ surface: 'storefront', ref: 'theme/b', change: 'modified' }] as never;
    const refused = standingArtifactsRefusal({ sent, wrote: false, held });
    expect(refused?.code).toBe('MARK_ALREADY_STANDS');
    expect(refused?.detail).toContain(DELETE_ROUTE);
  });
});
