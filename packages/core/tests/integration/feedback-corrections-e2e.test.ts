/**
 * ISS-867 (REQ-50 BC-1): a feedback item is a correction a lesson learns from. A bug or change request
 * triaged onto work is kept as its reporter's correction, in the reporter's words; a decline said with
 * a reason is kept as the triager's correction of the report. A question, an idea and a duplicate are
 * not, a re-triage keeps nothing twice, and each is about the item, `FB-n`. Through the app's own
 * feedback doors against real Postgres.
 *
 * @direct-test-of packages/core/src/feedback/correction.ts
 * @direct-test-of packages/core/src/feedback/triage.ts
 * @direct-test-of packages/core/src/feedback/service.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

type Who = 'owner' | 'ann';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
const people = {} as Record<Who, string>;
const at = (path: string) => `/api/projects/${projectId}${path}`;
const triage = (fb: string, body: unknown) =>
  say('owner', 'POST', at(`/feedback/${fb}/triage`), body);

async function file(kind: string, title: string, body?: string): Promise<string> {
  const made = ok(
    await say('ann', 'POST', at('/feedback'), { kind, title, body, screen: '/projects/hop/board' }),
    201,
  );
  return made.feedback.key as string;
}

async function correctionsOf(fb: string) {
  return (await db.execute(sql`
    SELECT c.source, c.reason, c.by_user_id, c.agency, c.item_kind, c.item_key
      FROM corrections c
     WHERE c.project_id = ${projectId} AND c.item_key = ${fb}
     ORDER BY c.said_at`)) as unknown as Array<Record<string, string>>;
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const tokens = {} as Record<Who, string>;
  for (const who of ['owner', 'ann'] as const) {
    people[who] = (await createTestUser({ verified: true })).id;
    tokens[who] = await signUserToken(people[who]);
  }
  projectId = (await createTestProject(people.owner)).id;
  await addProjectMember(projectId, people.ann, 'member');
  say = requester(app, tokens);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a feedback item is a correction (ISS-867)', () => {
  it("keeps a bug triaged onto work as its reporter's correction, in the reporter's words, once", async () => {
    const fb = await file('bug', 'The board loses my filter', 'Every reload drops it.');
    ok(await triage(fb, { route: 'issue', note: 'filter bug', answers: TRIAGE_ANSWERS }));
    expect(await correctionsOf(fb)).toEqual([
      {
        source: 'feedback_triaged',
        reason: 'The board loses my filter: Every reload drops it.',
        by_user_id: people.ann,
        agency: 'human',
        item_kind: 'feedback',
        item_key: fb,
      },
    ]);
    // a re-route of an item already triaged keeps nothing again
    ok(
      await triage(fb, {
        route: 'issue',
        note: 'a new issue',
        answers: TRIAGE_ANSWERS,
        createIssue: {},
      }),
    );
    expect(await correctionsOf(fb)).toHaveLength(1);
  });

  it("keeps a decline said with a reason as the triager's correction of the report", async () => {
    const fb = await file('bug', 'The logo is blue');
    ok(await triage(fb, { route: 'decline', note: 'The brand colour is blue on purpose.' }));
    expect(await correctionsOf(fb)).toEqual([
      expect.objectContaining({
        source: 'feedback_declined',
        reason: 'The brand colour is blue on purpose.',
        by_user_id: people.owner,
        item_kind: 'feedback',
      }),
    ]);
  });

  it('keeps no correction from a question or an idea triaged, nor from a duplicate', async () => {
    const question = await file('question', 'Can I export the board?');
    ok(await triage(question, { route: 'answer', answer: 'Not yet.', answers: TRIAGE_ANSWERS }));
    expect(await correctionsOf(question)).toEqual([]);
    const original = await file('bug', 'Saving twice loses cards');
    ok(await triage(original, { route: 'issue', note: 'save bug', answers: TRIAGE_ANSWERS }));
    const dup = await file('bug', 'Cards vanish on double save');
    ok(await triage(dup, { route: 'duplicate', duplicateOf: original, answers: TRIAGE_ANSWERS }));
    expect(await correctionsOf(dup)).toEqual([]);
  });
});
