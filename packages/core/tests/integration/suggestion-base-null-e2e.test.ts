/**
 * ISS-571 / FB-152 (REQ-8 BC-1): a suggestion on a target that holds no revision is based on none,
 * and says so with `baseRevision: null`. On forge-dev 088b7d85f nothing a caller read said that: the
 * create shape listed a bare `baseRevision`, and a number sent against a revisionless target was
 * refused SUGGESTION_BASE_STALE "the target's head is no revision ... propose against it", so callers
 * tried 0 and then 1 before guessing null. The shape, the schema's own refusal and the stale refusal
 * now each name null; a target that holds a revision still takes its number.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
const at = (path: string) => `/api/projects/${projectId}${path}`;
const as = (method: string, path: string, body?: unknown) => say('owner', method, at(path), body);
const refusals = (r: Reply): Doc[] => (r.json?.error?.refusals ?? []) as Doc[];

async function issue(title: string): Promise<string> {
  return ok(await as('POST', '/issues', { title }), 201).displayId as string;
}

async function requirement(title: string, agreed: boolean): Promise<string> {
  const key = ok(
    await as('POST', '/requirements', {
      title,
      reason: 'the rule it states',
      criteria: [{ body: 'A saved board shows every card it had.' }],
    }),
    201,
  ).key as string;
  if (agreed) {
    ok(await as('POST', `/requirements/${key}/revisions/1/propose`, {}));
    ok(await as('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'agreed' }));
  }
  return key;
}

const onIssue = (target: string, root: string, baseRevision: unknown) =>
  as('POST', '/suggestions', {
    kind: 'duplicate',
    issue: target,
    baseRevision,
    payload: { duplicateOf: root },
  });

const onRequirement = (target: string, other: string, baseRevision: unknown) =>
  as('POST', '/suggestions', {
    kind: 'duplicate',
    requirement: target,
    baseRevision,
    payload: { duplicateOf: other },
  });

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const owner = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(owner)).id;
  await addProjectMember(projectId, owner, 'owner');
  say = requester(app, { owner: await signUserToken(owner) });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('the create shape names baseRevision as a number or null', () => {
  it('a body missing baseRevision is refused with the shape, which says number | null', async () => {
    const root = await issue('The board loses cards on save');
    const target = await issue('Cards vanish after saving');
    const r = await as('POST', '/suggestions', {
      kind: 'duplicate',
      issue: target,
      payload: { duplicateOf: root },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    expect(JSON.stringify(r.json)).toContain('baseRevision: number | null');
    expect(refusals(r).map((x) => x.path)).toContain('/baseRevision');
  });

  it('a revision below 1 is refused at /baseRevision naming null for a revisionless target', async () => {
    const root = await issue('Search returns nothing for quoted words');
    const target = await issue('Quoted search is empty');
    const r = await onIssue(target, root, 0);
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    const at0 = refusals(r).find((x) => x.path === '/baseRevision');
    expect(at0?.detail ?? JSON.stringify(r.json)).toContain('null');
  });
});

describe('a target that holds no revision', () => {
  it('happy: an issue takes baseRevision null and records the suggestion against none', async () => {
    const root = await issue('Export drops the last row');
    const target = await issue('CSV export is one row short');
    const made = ok(await onIssue(target, root, null), 201);
    expect(made.suggestion.status).toBe('proposed');
    expect(made.suggestion.baseRevision).toBeNull();
  });

  it('negative: a number on an issue is refused SUGGESTION_BASE_STALE telling the caller to send null', async () => {
    const root = await issue('Login loops on an expired token');
    const target = await issue('Expired session redirects forever');
    for (const n of [1, 2]) {
      const r = await onIssue(target, root, n);
      expect(r.status, JSON.stringify(r.json)).toBe(409);
      expect(refusals(r).map((x) => `${x.code} ${x.path}`)).toEqual([
        'SUGGESTION_BASE_STALE /baseRevision',
      ]);
      const detail = refusals(r)[0]?.detail as string;
      expect(detail).toContain(`revision ${n}`);
      expect(detail).toContain('baseRevision: null');
    }
  });

  it('negative: a requirement with no current revision refuses a number the same way', async () => {
    const other = await requirement('A board keeps its cards', false);
    const target = await requirement('Saving keeps every card', false);
    const r = await onRequirement(target, other, 1);
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(refusals(r).map((x) => x.code)).toEqual(['SUGGESTION_BASE_STALE']);
    expect(refusals(r)[0]?.detail).toContain('baseRevision: null');
    ok(await onRequirement(target, other, null), 201);
  });
});

describe('boundary: a target that holds a revision still takes its number', () => {
  it('an agreed requirement at revision 1 takes 1, refuses 2 naming revision 1, and refuses null naming 1', async () => {
    const other = await requirement('Exports keep every row', true);
    const target = await requirement('A CSV holds every row', true);
    const stale = await onRequirement(target, other, 2);
    expect(stale.status, JSON.stringify(stale.json)).toBe(409);
    expect(refusals(stale)[0]?.code).toBe('SUGGESTION_BASE_STALE');
    expect(refusals(stale)[0]?.detail).toContain("the target's head is revision 1");
    expect(refusals(stale)[0]?.detail).not.toContain('null');
    const unbased = await onRequirement(target, other, null);
    expect(refusals(unbased).map((x) => x.code)).toEqual(['SUGGESTION_BASE_REQUIRED']);
    expect(refusals(unbased)[0]?.detail).toContain('send baseRevision: 1');
    const made = ok(await onRequirement(target, other, 1), 201);
    expect(made.suggestion.baseRevision).toBe(1);
  });
});
