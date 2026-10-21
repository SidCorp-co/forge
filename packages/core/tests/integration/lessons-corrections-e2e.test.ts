// REQ-50 BC-1: every return, rejection or failing verdict said with a reason, and every chat reply the
// classifier reads as a correction, is kept as one correction linked to its item. Each source is
// driven through its own door (or, for chat, the stored turn), against real Postgres and the outbox.
//
// @direct-test-of packages/core/src/lessons/corrections.ts
// @direct-test-of packages/core/src/lessons/consumers.ts
// @direct-test-of packages/core/src/suggestions/correction.ts
// @direct-test-of packages/core/src/issues/criteria/verdict-correction.ts
// @direct-test-of packages/core/src/assistant/turn-lessons.ts

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  rows,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';

const classify = vi.hoisted(() => ({
  answer: {
    correction: true,
    confidence: 0.9,
    what: 'It drafted the form without the consent box.',
  },
  calls: 0,
}));

vi.mock('../../src/integrations/llm/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/integrations/llm/index.js')>();
  return {
    ...real,
    callFastModelObject: async (scope: { surface: string }, ...rest: unknown[]) => {
      if (scope.surface !== 'lessons') {
        return (real.callFastModelObject as (...a: unknown[]) => unknown)(scope, ...rest);
      }
      classify.calls += 1;
      return { ok: true, value: classify.answer, modelId: 'test-fast' };
    },
  };
});

const LIVE = '0d91ae7c74f70295ede115463b17559e650b5207';
let say: (who: 'owner' | 'member', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let memberId = '';
const at = (path: string) => `/api/projects/${projectId}${path}`;

type Kept = {
  source: string;
  item_kind: string;
  item_key: string;
  reason: string;
  agency: string;
  by_user_id: string | null;
  score: number | null;
};
const kept = (source: string) =>
  rows<Kept>(sql`
    SELECT source, item_kind, item_key, reason, agency, by_user_id, score
    FROM corrections WHERE project_id = ${projectId} AND source = ${source} ORDER BY said_at`);

async function agreedRequirement(title: string): Promise<string> {
  const key = ok(
    await say('owner', 'POST', at('/requirements'), {
      title,
      reason: 'the rule it states',
      criteria: [{ body: 'A saved board shows every card it had.' }],
    }),
    201,
  ).key as string;
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  ok(await say('owner', 'POST', at(`/requirements/${key}/revisions/1/propose`), {}));
  ok(
    await say('owner', 'POST', at(`/requirements/${key}/revisions/1/accept`), {
      reason: 'BA review',
    }),
  );
  ok(
    await say('owner', 'POST', at(`/requirements/${key}/agree`), {
      revision: 1,
      reason: 'signed r1',
    }),
  );
  return key;
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  memberId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, memberId, 'member');
  say = requester(app, {
    owner: await signUserToken(ownerId),
    member: await signUserToken(memberId),
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(() => {
  classify.calls = 0;
});

describe('a correction is kept, linked to its item, from each source (BC-1)', () => {
  it('a suggestion rejected with a reason', async () => {
    const req = await agreedRequirement('Boards keep their cards');
    const made = ok(
      await say('member', 'POST', at('/suggestions'), {
        kind: 'breakdown',
        requirement: req,
        baseRevision: 1,
        payload: {
          issues: [
            {
              title: 'Save every card',
              criteria: [{ body: 'a reload shows every card', tracesTo: 'BC-1' }],
              complexity: 's',
              builds: null,
            },
          ],
        },
      }),
      201,
    );
    const id = (made.suggestion as Doc).id as string;
    ok(
      await say('owner', 'POST', at(`/suggestions/${id}/reject`), {
        reason: 'Slice by screen, not by table.',
      }),
    );
    expect(await kept('suggestion_rejected')).toEqual([
      expect.objectContaining({
        item_kind: 'suggestion',
        item_key: req,
        reason: 'Slice by screen, not by table.',
        agency: 'human',
        by_user_id: ownerId,
      }),
    ]);
  });

  it('a requirement revision returned with a reason', async () => {
    const key = ok(
      await say('owner', 'POST', at('/requirements'), {
        title: 'Discharge letters',
        reason: 'a letter goes home',
        criteria: [{ body: 'A letter lists every medicine.' }],
      }),
      201,
    ).key as string;
    ok(await say('owner', 'POST', at(`/requirements/${key}/revisions/1/propose`), {}));
    ok(
      await say('owner', 'POST', at(`/requirements/${key}/revisions/1/return`), {
        reason: 'Name who signs the letter.',
      }),
    );
    expect(await kept('revision_returned')).toEqual([
      expect.objectContaining({
        item_kind: 'requirement',
        item_key: `${key} r1`,
        reason: 'Name who signs the letter.',
      }),
    ]);
  });

  it('a workflow design returned with a reason', async () => {
    const d = JSON.parse(
      readFileSync(
        new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
        'utf8',
      ),
    );
    d.project = projectId;
    d.flow = 'lessons-flow';
    const made = ok(
      await say('owner', 'POST', at('/workflows'), { baseRevision: null, document: d }),
      201,
    );
    const id = made.document.id as string;
    ok(await say('owner', 'POST', at(`/workflows/${id}/design/propose`), { revision: 1 }));
    ok(
      await say('owner', 'POST', at(`/workflows/${id}/design/decision`), {
        revision: 1,
        decision: 'return',
        reason: 'Draw the consent check.',
      }),
    );
    expect(await kept('design_returned')).toEqual([
      expect.objectContaining({
        item_kind: 'workflow',
        item_key: 'lessons-flow r1',
        reason: 'Draw the consent check.',
      }),
    ]);
  });

  it('a failing verdict with a reason, and not a passing one', async () => {
    const unplant = plantLiveBuild(LIVE);
    try {
      const req = await agreedRequirement('Reminders');
      const { id: issueId } = await createTestIssue(projectId, ownerId, 40, {
        status: 'closed',
        createdAt: new Date(),
        mergedAt: new Date(),
      });
      ok(await say('owner', 'POST', at(`/requirements/${req}/issues`), { issue: 'ISS-40' }));
      ok(
        await say('owner', 'POST', `/api/issues/${issueId}/criteria/traces`, { codes: ['BC-1'] }),
        201,
      );
      const judge = (verdict: string, reason: string) =>
        say('owner', 'POST', `/api/issues/${issueId}/verdicts`, {
          criterion: 1,
          verdict,
          reason,
          identity: { kind: 'commit', sha: LIVE },
          evidence: ['reminder-1440.png'],
        });
      ok(await judge('pass', 'Seen on the build.'), 201);
      ok(await judge('fail', 'The reminder shows the wrong ward.'), 201);
      expect(await kept('verdict_failed')).toEqual([
        expect.objectContaining({
          item_kind: 'issue',
          item_key: 'ISS-40 #1',
          reason: 'The reminder shows the wrong ward.',
        }),
      ]);
    } finally {
      unplant();
    }
  });

  it('a mockup returned with a reason, read through the mockup contract on the outbox', async () => {
    const issue = await createTestIssue(projectId, ownerId, 41, {
      status: 'open',
      createdAt: new Date(),
    });
    const made = ok(
      await say('member', 'POST', at('/mockups'), {
        target: { issue: issue.key },
        kind: 'html',
        name: 'checkout.html',
        mime: 'text/html',
        caption: 'the checkout',
        contentBase64: Buffer.from('<p>checkout</p>').toString('base64'),
      }),
      201,
    );
    const key = made.mockup.key as string;
    ok(
      await say('owner', 'POST', at(`/mockups/${key}/return`), {
        reason: 'Put the total above the button.',
      }),
    );
    await settleOutbox();
    expect(await kept('mockup_returned')).toEqual([
      expect.objectContaining({
        item_kind: 'mockup',
        item_key: key,
        reason: 'Put the total above the button.',
        by_user_id: ownerId,
      }),
    ]);
  });

  it('a chat reply the classifier reads as a correction, kept at the threshold and shown with its score', async () => {
    const conversationId = randomUUID();
    await rows(sql`
      INSERT INTO conversations (id, adapter, external_id, shape, mode, title)
      VALUES (${conversationId}, 'web', ${`lessons-${conversationId}`}, 'direct', 'assistant', 'Consent form')`);
    const say2 = async (seq: number, role: string, content: string, author: string | null) =>
      (
        await rows<{
          id: string;
          seq: number;
          role: string;
          content: string;
          author_user_id: string | null;
          silence_reason: null;
        }>(sql`
        INSERT INTO conversation_messages (conversation_id, seq, role, author_user_id, content)
        VALUES (${conversationId}, ${seq}, ${role}, ${author}, ${content})
        RETURNING id, seq, role, content, author_user_id, silence_reason`)
      )[0];
    const stored = (m: Awaited<ReturnType<typeof say2>>) =>
      ({
        id: m?.id,
        seq: m?.seq,
        role: m?.role,
        content: m?.content,
        authorUserId: m?.author_user_id,
        silenceReason: null,
      }) as never;
    const { noteTurnLessons } = await import('../../src/assistant/turn-lessons.js');
    const assistant = await say2(0, 'assistant', 'Here is the intake form.', null);
    const reply = await say2(1, 'user', 'No, it needs the consent box first.', ownerId);
    await noteTurnLessons(projectId, conversationId, stored(assistant), [stored(reply)]);
    await settleOutbox();
    expect(classify.calls).toBe(1);
    expect(await kept('chat')).toEqual([
      expect.objectContaining({
        item_kind: 'conversation',
        reason: 'It drafted the form without the consent box.',
        score: expect.closeTo(0.9, 5),
        by_user_id: ownerId,
      }),
    ]);
    const marks = ok(await say('owner', 'GET', at(`/lessons/chat/${conversationId}`)));
    expect(marks.corrections).toEqual([
      expect.objectContaining({ messageId: reply?.id, dismissed: false }),
    ]);

    // below the threshold nothing is kept
    classify.answer = { correction: true, confidence: 0.5, what: 'Maybe the tone.' };
    const assistant2 = await say2(2, 'assistant', 'Done.', null);
    const reply2 = await say2(3, 'user', 'Hmm, ok.', ownerId);
    await noteTurnLessons(projectId, conversationId, stored(assistant2), [stored(reply2)]);
    await settleOutbox();
    expect(classify.calls).toBe(2);
    expect(await kept('chat')).toHaveLength(1);
  });

  it('a return said with no reason keeps nothing, and a retried event keeps one row', async () => {
    const { db } = await import('../../src/db/client.js');
    const { recordCorrection } = await import('../../src/lessons/index.js');
    const input = {
      projectId,
      source: 'mockup_accepted' as const,
      sourceRef: `retry-${randomUUID()}`,
      item: { kind: 'mockup' as const, id: randomUUID(), key: 'MK-9' },
      by: { userId: ownerId, agency: 'human' as const },
    };
    expect(
      await db.transaction((tx) => recordCorrection(tx, { ...input, reason: '   ' })),
    ).toBeNull();
    const first = await db.transaction((tx) =>
      recordCorrection(tx, { ...input, reason: 'Keep the logo left.' }),
    );
    const again = await db.transaction((tx) =>
      recordCorrection(tx, { ...input, reason: 'Keep the logo left.' }),
    );
    expect(first).not.toBeNull();
    expect(again).toBeNull();
    expect(await kept('mockup_accepted')).toHaveLength(1);
  });
});
