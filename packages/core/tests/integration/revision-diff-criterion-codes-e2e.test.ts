/**
 * REQ-30 BC-3: a change wish is recorded as a requirement revision. On forge-dev 2026-10-08 the BA
 * assistant's revision suggestions that ADDED a criterion carried a code it made up (REQ-32's
 * BC-15, REQ-33's BC-7) and were created; only the person's Accept refused them
 * (CRITERION_CODE_UNKNOWN), so the turn that wrote them never learnt and the person did the
 * correcting. A revision_diff naming a code that is not live on its base is refused where it is
 * proposed, by name; the same suggestion with the new criterion carrying no code is created, and its
 * accept gives the new criterion the next code.
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
import { createTestProject, createTestUser } from '../helpers/factories.js';

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let req = '';
const at = (path: string) => `/api/projects/${projectId}${path}`;
const as = (method: string, path: string, body?: unknown) => say('owner', method, at(path), body);

const revision = (criteria: Doc[]): Doc => ({
  kind: 'revision_diff',
  requirement: req,
  baseRevision: 1,
  payload: { reason: 'the owner asked for an analysis, not a copy of a page', criteria },
});
const KEPT = { code: 'BC-1', body: 'A saved board shows every card it had.' };
const REWORDED = { code: 'BC-2', body: 'A board opens in under a second with its cards in order.' };
const ADDED = { body: 'A board says how many cards each column holds.' };

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const owner = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(owner)).id;
  say = requester(app, { owner: await signUserToken(owner) });
  req = ok(
    await as('POST', '/requirements', {
      title: 'The board keeps its cards',
      reason: 'the rule it states',
      criteria: [{ body: KEPT.body }, { body: 'A board opens in under a second.' }],
    }),
    201,
  ).key as string;
  ok(await as('POST', `/requirements/${req}/revisions/1/propose`, {}));
  ok(await as('POST', `/requirements/${req}/revisions/1/accept`, { reason: 'BA review' }));
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a revision_diff suggestion that adds a criterion', () => {
  it('is refused where it is proposed when the new criterion carries a code it made up', async () => {
    const res = await as(
      'POST',
      '/suggestions',
      revision([KEPT, REWORDED, { code: 'BC-99', ...ADDED }]),
    );
    expect(res.status, JSON.stringify(res.json)).toBe(422);
    const refusals = (res.json.error?.refusals ?? []) as Doc[];
    expect(refusals.map((r) => `${r.code} ${r.path}`)).toEqual([
      'CRITERION_CODE_UNKNOWN /payload/criteria/2/code',
    ]);
    expect(refusals[0]?.detail).toContain('BC-99 is not a live criterion');
    expect(refusals[0]?.detail).toContain('(BC-1, BC-2)');
    expect(refusals[0]?.detail).toContain('a new criterion carries no code');
    const waiting = ok(await as('GET', `/suggestions?requirement=${req}&status=proposed`));
    expect(JSON.stringify(waiting)).not.toContain('BC-99');
  });

  it('is refused naming one code twice', async () => {
    const twice = await as('POST', '/suggestions', revision([KEPT, { ...REWORDED, code: 'BC-1' }]));
    expect(twice.status).toBe(422);
    expect(((twice.json.error?.refusals ?? []) as Doc[]).map((r) => r.code)).toEqual([
      'CRITERION_CODE_DUPLICATE',
    ]);
  });

  it('is created with no code on the new criterion, and its accept gives it the next one', async () => {
    const made = ok(await as('POST', '/suggestions', revision([KEPT, REWORDED, ADDED])), 201);
    ok(
      await as('POST', `/suggestions/${made.suggestion.id}/accept`, {
        reason: 'as the owner asked',
      }),
    );
    const read = ok(await as('GET', `/requirements/${req}`));
    expect(read.latestRevision).toEqual({ revision: 2, state: 'proposed' });
    const r2 = (read.revisions as Doc[]).find((r) => r.revision === 2);
    if (!r2) throw new Error('the accept wrote no revision 2');
    expect((r2.criteria as Doc[]).map((c) => `${c.code} ${c.body}`)).toEqual([
      `BC-1 ${KEPT.body}`,
      `BC-2 ${REWORDED.body}`,
      `BC-3 ${ADDED.body}`,
    ]);
  });
});
