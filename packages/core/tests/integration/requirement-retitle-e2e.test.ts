/**
 * A requirement is retitled by a revision a person agrees (ISS-829, FB-408). sidcorp-mail REQ-2 was
 * agreed at r3 with criteria that contradicted its title, and no door could rename it: PATCH takes
 * only the owner, and the revise had no title. Now a revision names the title it gives, the accept
 * applies it, and until then the title stands. A blank title is refused by name.
 *
 * @direct-test-of packages/core/src/requirements/revision-write.ts
 * @direct-test-of packages/core/src/requirements/agree.ts
 * @direct-test-of packages/core/src/requirements/revision-routes.ts
 * @direct-test-of packages/core/src/requirements/revision-view.ts
 * @direct-test-of packages/core/drizzle/migrations/0587_a_revision_names_the_title_it_gives.sql
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  refusalCodes,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, makeAgreeReady, rows } from '../helpers/factories.js';

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
const as = (method: string, path: string, body?: unknown) =>
  say('owner', method, `/api/projects/${projectId}${path}`, body);

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

const CRITERION = { code: 'BC-1', body: 'Each node signs with its own DKIM key.' };

/** A requirement agreed at r1 under a title its criterion contradicts, as REQ-2 stood. */
async function agreed(title: string): Promise<string> {
  const key = ok(
    await as('POST', '/requirements', {
      title,
      reason: 'the rule it states',
      criteria: [{ body: CRITERION.body }],
    }),
    201,
  ).key as string;
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  ok(await as('POST', `/requirements/${key}/revisions/1/propose`, {}));
  ok(await as('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'Accepted.' }));
  ok(await as('POST', `/requirements/${key}/agree`, { revision: 1, reason: 'Agreed.' }));
  return key;
}

/** A revision on r1 carrying the same criterion, with `extra` (the title) beside it. */
const revise = (key: string, extra: Record<string, unknown>) =>
  as('POST', `/requirements/${key}/revisions`, {
    baseRevision: 1,
    reason: 'the title says the opposite of what was agreed',
    criteria: [CRITERION],
    ...extra,
  });

const read = async (key: string) => ok(await as('GET', `/requirements/${key}`)) as Doc;
const revisionOf = (doc: Doc, n: number) =>
  (doc.revisions as Doc[]).find((r) => r.revision === n) as Doc;

const storedTitles = (key: string) =>
  rows<{ revision: number; title: string | null }>(sql`
    SELECT rr.revision, rr.title FROM requirement_revisions rr
      JOIN requirements r ON r.id = rr.requirement_id
     WHERE r.project_id = ${projectId} AND r.req_seq = ${Number(key.slice(4))}
     ORDER BY rr.revision`);

describe('a revision retitles a requirement once a person accepts it (ISS-829)', () => {
  it('a title-only revision, proposed and accepted, changes the title, and its changes name it', async () => {
    const key = await agreed('Mail signs with one DKIM key on every node');

    ok(await revise(key, { title: 'Each mail node signs with its own DKIM key' }));
    const proposed = ok(await as('POST', `/requirements/${key}/revisions/2/propose`, {})) as Doc;
    expect(revisionOf(proposed, 2).specChanges.title).toEqual({
      before: 'Mail signs with one DKIM key on every node',
      after: 'Each mail node signs with its own DKIM key',
    });
    expect(revisionOf(proposed, 2).criteriaChanges).toEqual({
      against: 1,
      added: [],
      changed: [],
      removed: [],
    });

    ok(await as('POST', `/requirements/${key}/revisions/2/accept`, { reason: 'Retitle agreed.' }));

    const after = await read(key);
    expect(after.title).toBe('Each mail node signs with its own DKIM key');
    expect(after.currentRevision).toBe(2);
    expect(revisionOf(after, 2).title).toBe('Each mail node signs with its own DKIM key');
    // the revision before keeps the title it gave: the history reads both
    expect(revisionOf(after, 1).title).toBe('Mail signs with one DKIM key on every node');
  });

  it('a revision not yet accepted leaves the title as it was, drafted, proposed or returned', async () => {
    const key = await agreed('Bounces are kept for a week');

    ok(await revise(key, { title: 'Bounces are kept for thirty days' }));
    expect((await read(key)).title).toBe('Bounces are kept for a week');

    ok(await as('POST', `/requirements/${key}/revisions/2/propose`, {}));
    expect((await read(key)).title).toBe('Bounces are kept for a week');

    ok(await as('POST', `/requirements/${key}/revisions/2/return`, { reason: 'not this wording' }));
    const returned = await read(key);
    expect(returned.title).toBe('Bounces are kept for a week');
    expect(returned.currentRevision).toBe(1);
  });

  it('a revision naming no title carries the head’s and changes nothing; one naming the same reports no change', async () => {
    const key = await agreed('Spam scores are logged');

    const carried = ok(await revise(key, {})) as Doc;
    expect(revisionOf(carried, 2).title).toBe('Spam scores are logged');
    expect(revisionOf(carried, 2).specChanges.title).toBeNull();
    // a draft's edit that names no title keeps the one the draft gives
    ok(
      await as('PUT', `/requirements/${key}/revisions/2`, {
        title: 'Spam scores are logged per message',
        criteria: [CRITERION],
      }),
    );
    const kept = ok(
      await as('PUT', `/requirements/${key}/revisions/2`, { criteria: [CRITERION] }),
    ) as Doc;
    expect(revisionOf(kept, 2).title).toBe('Spam scores are logged per message');
    ok(
      await as('PUT', `/requirements/${key}/revisions/2`, {
        title: 'Spam scores are logged',
        criteria: [CRITERION],
      }),
    );
    ok(await as('POST', `/requirements/${key}/revisions/2/propose`, {}));
    const same = ok(
      await as('POST', `/requirements/${key}/revisions/2/accept`, { reason: 'Same title.' }),
    ) as Doc;
    expect(revisionOf(same, 2).specChanges.title).toBeNull();
    expect(same.title).toBe('Spam scores are logged');
  });

  it('refuses a blank title by name, at the door and in the write, writing nothing', async () => {
    const key = await agreed('Relays retry for a day');

    const blank = await revise(key, { title: '   ' });
    expect(blank.status, JSON.stringify(blank.json)).toBe(400);
    const refusal = (blank.json as Doc).error.refusals[0] as Doc;
    expect(refusal.path).toBe('/title');
    expect(refusal.detail).toContain('The title is blank');

    const long = await revise(key, { title: 'x'.repeat(501) });
    expect(long.status).toBe(400);
    expect((long.json as Doc).error.refusals[0].path).toBe('/title');

    // a caller of the write that skips the door's schema meets the same rule, by its own code
    const { writeRevision } = await import('../../src/requirements/service.js');
    const written = await writeRevision({
      projectId,
      ref: key,
      actor: { userId: ownerId, agency: 'human' },
      baseRevision: 1,
      write: { title: ' ', reason: 'blank', criteria: [CRITERION] },
    });
    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.refusals.map((r) => r.code)).toEqual(['REQUIREMENT_TITLE_INVALID']);
    expect(written.refusals[0]?.path).toBe('/title');
    expect(written.refusals[0]?.detail).toContain('title is blank');

    expect((await storedTitles(key)).map((r) => r.revision)).toEqual([1]);
    expect((await read(key)).title).toBe('Relays retry for a day');
  });

  it('freezes a proposed revision’s title: the guard refuses changing it in place', async () => {
    const key = await agreed('Mailboxes hold ten gigabytes');
    ok(await revise(key, { title: 'Mailboxes hold twenty gigabytes' }));
    ok(await as('POST', `/requirements/${key}/revisions/2/propose`, {}));

    await expect(
      rows(sql`
        UPDATE requirement_revisions rr SET title = 'Mailboxes hold no limit'
          FROM requirements r
         WHERE r.id = rr.requirement_id AND r.project_id = ${projectId}
           AND r.req_seq = ${Number(key.slice(4))} AND rr.revision = 2`),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/^REVISION_IMMUTABLE: .* revision 2 is proposed/) },
    });
    expect(await storedTitles(key)).toEqual([
      { revision: 1, title: 'Mailboxes hold ten gigabytes' },
      { revision: 2, title: 'Mailboxes hold twenty gigabytes' },
    ]);
  });
});

describe('the door names no other rename', () => {
  it('PATCH still takes only the owner: a title there is refused by name', async () => {
    const key = await agreed('Aliases resolve once');
    const res = await as('PATCH', `/requirements/${key}`, { title: 'Aliases resolve twice' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain('title');
    expect((await read(key)).title).toBe('Aliases resolve once');
  });

  it('refuses a revision whose title is not text by the same code path', async () => {
    const key = await agreed('Quotas reset monthly');
    const res = await revise(key, { title: 42 });
    expect(res.status).toBe(400);
    expect(refusalCodes(res).length).toBeGreaterThan(0);
  });
});
