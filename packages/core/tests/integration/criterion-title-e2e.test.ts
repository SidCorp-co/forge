/**
 * ISS-1131 (FB-567 point 3): a criterion row shows a short title, with its full sentence on demand.
 * A requirement criterion and an issue criterion each take an optional `title` of at most eight
 * words through the writes that already carry them (a requirement's revision, an issue's criteria
 * PUT), refused by name over that (CRITERION_TITLE_TOO_LONG), and read back beside the sentence. An
 * issue criterion retitled keeps its row and its verdicts; a write that leaves the title out keeps it.
 * The tables hold the same rule (0634), so no writer stores a longer one.
 *
 * @direct-test-of packages/core/src/issues/criteria/store.ts
 * @direct-test-of packages/core/src/issues/criteria/input-schemas.ts
 * @direct-test-of packages/core/src/requirements/rules.ts
 * @direct-test-of packages/core/src/requirements/revision-criteria.ts
 * @direct-test-of packages/core/src/requirements/revision-view.ts
 * @direct-test-of packages/core/drizzle/migrations/0634_a_criterion_carries_a_short_title.sql
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  refusalCodes,
  refusedByDb,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { createTestIssue, createTestProject, createTestUser, rows } from '../helpers/factories.js';

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
const as = (method: string, path: string, body?: unknown) => say('owner', method, path, body);

const NINE = 'Owner sees the review page with every fact once';

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  say = requester(app, { owner: await signUserToken(ownerId) });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('an issue criterion carries a short title', () => {
  it('reads it back, keeps the row on a retitle, keeps it when left out, and refuses nine words by name', async () => {
    const issue = await createTestIssue(projectId, ownerId, 41, {
      status: 'open',
      createdAt: new Date(),
    });
    const put = (criteria: unknown[]) =>
      as('PUT', `/api/issues/${issue.id}/criteria`, { criteria });
    const read = async () =>
      (ok(await as('GET', `/api/issues/${issue.id}/criteria`)).criteria as Doc[]).map((c) => ({
        id: c.id,
        title: c.title,
        statement: c.statement,
      }));
    const SENTENCE = 'The review page shows each fact once, and opens the rest on demand.';

    ok(await put([{ n: 1, statement: SENTENCE, title: 'Each fact once' }]));
    const [first] = await read();
    expect(first).toMatchObject({ title: 'Each fact once', statement: SENTENCE });

    ok(await put([{ n: 1, statement: SENTENCE, title: 'One fact, once' }]));
    expect(await read(), "a retitle is the row's label: it keeps the row").toEqual([
      { id: first?.id, title: 'One fact, once', statement: SENTENCE },
    ]);

    ok(await put([{ n: 1, statement: SENTENCE }]));
    expect((await read())[0]?.title, 'a write leaving the title out dropped it').toBe(
      'One fact, once',
    );

    const long = await put([{ n: 1, statement: SENTENCE, title: NINE }]);
    expect(long.status).toBeGreaterThanOrEqual(400);
    expect(refusalCodes(long)).toEqual(['CRITERION_TITLE_TOO_LONG']);
    expect((await read())[0]?.title).toBe('One fact, once');

    ok(await put([{ n: 1, statement: SENTENCE, title: null }]));
    expect((await read())[0]?.title).toBeNull();
  });
});

describe('a requirement criterion carries a short title', () => {
  it('writes it through the revision, reads it back, and refuses nine words by name at its criterion', async () => {
    const at = (path: string) => `/api/projects/${projectId}${path}`;
    const long = await as('POST', at('/requirements'), {
      title: 'Review page',
      reason: 'the owner asked',
      criteria: [{ body: 'The review page shows each fact once.', title: NINE }],
    });
    expect(long.status).toBeGreaterThanOrEqual(400);
    expect(refusalCodes(long)).toEqual(['CRITERION_TITLE_TOO_LONG']);

    const key = ok(
      await as('POST', at('/requirements'), {
        title: 'Review page',
        reason: 'the owner asked',
        criteria: [
          { body: 'The review page shows each fact once.', title: 'Each fact once' },
          { body: 'Scope and assumptions fold, opening on demand.' },
        ],
      }),
      201,
    ).key as string;
    const doc = ok(await as('GET', at(`/requirements/${key}`))) as Doc;
    const r1 = (doc.revisions as Doc[]).find((r) => r.revision === 1) as Doc;
    expect((r1.criteria as Doc[]).map((c) => [c.code, c.title])).toEqual([
      ['BC-1', 'Each fact once'],
      ['BC-2', null],
    ]);
  });

  it('holds the rule in the table for any writer (0634)', async () => {
    await refusedByDb(
      rows(sql`UPDATE requirement_criteria SET title = ${NINE} WHERE title IS NOT NULL`),
      /requirement_criteria_title_chk/,
    );
  });
});
