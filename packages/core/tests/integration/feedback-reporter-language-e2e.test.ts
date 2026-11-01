/**
 * Every notice a reporter gets about their item is the kernel fact — key, step, title — and only words
 * a person wrote, the same for every reader whatever language they read (ISS-857, owner ruling
 * agent-is-the-voice: no agent speaks on the bell, so core composes no sentence and translates none).
 * One notice kind per test: a decline, a merge into an original, a triager's message (each reporter of
 * a merged item), a triager's verify on their behalf past the window, and the ask to verify. The
 * project here writes Vietnamese; bo chose nothing, ann chose English, and both read the same fact.
 *
 * @direct-test-of packages/core/src/feedback/reporter-notices.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';
import { vouchedByPassingCriterion } from '../helpers/loop-close.js';
import { seedProjectDocument } from '../helpers/release-world.js';
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

type Who = 'owner' | 'ann' | 'bo';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerToken = '';
/** What puts back what a test planted, run once the file is done. */
const onTeardown: (() => void)[] = [];
const people = {} as Record<Who, string>;
const at = (path: string) => `/api/projects/${projectId}${path}`;
const item = (fb: string, act = '') => at(`/feedback/${fb}${act ? `/${act}` : ''}`);
const seq = (fb: string) => Number(fb.slice(3));

async function file(who: Who, title: string, kind = 'bug'): Promise<string> {
  return ok(
    await say(who, 'POST', at('/feedback'), { kind, title, screen: '/projects/hop/board' }),
    201,
  ).feedback.key as string;
}

/** What `who`'s bell holds about `fb`, oldest first. */
async function bell(
  who: Who,
  fb: string,
): Promise<{ type: string; title: string; body: string }[]> {
  await settleOutbox();
  return (await db.execute(sql`
    SELECT n.type, n.title, n.body
      FROM notification_deliveries d
      JOIN notification_delivery_members m ON m.delivery_id = d.id
      JOIN notifications n ON n.id = m.notification_id
     WHERE d.user_id = ${people[who]} AND n.project_id = ${projectId}
       AND n.title LIKE ${`%${fb}%`}
     ORDER BY n.created_at
  `)) as unknown as { type: string; title: string; body: string }[];
}

async function answered(who: Who, title: string): Promise<string> {
  const fb = await file(who, title, 'question');
  ok(
    await say('owner', 'POST', item(fb, 'triage'), {
      answers: TRIAGE_ANSWERS,
      route: 'answer',
      answer: 'Theo thiết kế.',
    }),
  );
  return fb;
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const tokens = {} as Record<Who, string>;
  for (const who of ['owner', 'ann', 'bo'] as const) {
    people[who] = (await createTestUser({ verified: true })).id;
    tokens[who] = await signUserToken(people[who]);
  }
  projectId = (await createTestProject(people.owner)).id;
  ownerToken = tokens.owner;
  await addProjectMember(projectId, people.ann, 'member');
  await addProjectMember(projectId, people.bo, 'member');
  await seedProjectDocument(projectId, people.owner, {
    environments: {},
    extra: { contentLanguage: 'vi' },
  });
  await db.execute(sql`
    INSERT INTO user_preferences (user_id, language) VALUES (${people.ann}, 'en')
  `);
  say = requester(app, tokens);
}, 120_000);

afterAll(async () => {
  for (const undo of onTeardown) undo();
  await closeWorld();
});

describe('a reporter reads each notice about their item as the kernel fact, in any language', () => {
  it('declined: the fact and the triager reason as written, the same for a reader of either language', async () => {
    const fb = await file('bo', 'Bảng mất bộ lọc');
    ok(
      await say('owner', 'POST', item(fb, 'triage'), { route: 'decline', note: 'Ngoài phạm vi.' }),
    );
    expect(await bell('bo', fb)).toEqual([
      {
        type: 'feedback_message',
        title: `${fb} · declined · Bảng mất bộ lọc`,
        body: 'Ngoài phạm vi.',
      },
    ]);
    const en = await file('ann', 'Board drops its filter');
    ok(await say('owner', 'POST', item(en, 'triage'), { route: 'decline', note: 'Not planned.' }));
    expect((await bell('ann', en))[0], 'no language changes the fact').toMatchObject({
      title: `${en} · declined · Board drops its filter`,
      body: 'Not planned.',
    });
  });

  it('duplicate: told which item carries their report', async () => {
    const original = await file('owner', 'Xuất file chậm');
    const fb = await file('bo', 'Xuất file rất chậm');
    ok(
      await say('owner', 'POST', item(fb, 'triage'), {
        answers: TRIAGE_ANSWERS,
        route: 'duplicate',
        duplicateOf: original,
      }),
    );
    const [n] = await bell('bo', fb);
    expect(n?.title).toBe(`${fb} · duplicate of ${original} · Xuất file rất chậm`);
    expect(n?.body ?? null, 'no sentence core composed').toBeNull();
  });

  it('message: each reporter of a merged item gets the same fact, the words as written', async () => {
    const fb = await file('bo', 'Thẻ bị trùng');
    const dup = await file('ann', 'Cards repeat');
    ok(
      await say('owner', 'POST', item(dup, 'triage'), {
        answers: TRIAGE_ANSWERS,
        route: 'duplicate',
        duplicateOf: fb,
      }),
    );
    ok(
      await say('owner', 'POST', item(fb, 'messages'), {
        audience: 'all_reporters',
        text: 'Đang xem.',
      }),
      201,
    );
    const told = {
      type: 'feedback_message',
      title: `${fb} · message · Thẻ bị trùng`,
      body: 'Đang xem.',
    };
    expect((await bell('bo', fb)).filter((n) => n.title.includes(' · message · '))).toEqual([told]);
    expect((await bell('ann', fb)).filter((n) => n.title.includes(' · message · '))).toEqual([
      told,
    ]);
  });

  it('verified for them: the sweep tells nothing, and the triager who verifies from the record is told the fact', async () => {
    const fb = await answered('bo', 'Vì sao bảng chỉ đọc?');
    const [row] = (await db.execute(sql`
      SELECT id FROM feedback WHERE project_id = ${projectId} AND fb_seq = ${seq(fb)}
    `)) as unknown as { id: string }[];
    const { unplant } = await vouchedByPassingCriterion({
      token: ownerToken,
      projectId,
      ownerId: people.owner,
      feedbackId: row?.id as string,
      seq: 900,
      sha: '5555555555555555555555555555555555555555',
    });
    onTeardown.push(unplant);
    await db.execute(sql`
      UPDATE feedback SET resolved_seen_at = now() - interval '60 days'
       WHERE project_id = ${projectId} AND fb_seq = ${seq(fb)}
    `);
    const { sweepResolvedFeedback } = await import('../../src/feedback/index.js');
    await sweepResolvedFeedback();
    expect(
      (await bell('bo', fb)).filter((x) => x.title.includes(' · verified · ')),
      'Feedback triage r16: nothing verifies an item by itself',
    ).toEqual([]);
    ok(await say('owner', 'POST', item(fb, 'verify'), {}));
    const [n] = (await bell('bo', fb)).filter((x) => x.title.includes(' · verified · '));
    expect(n?.title).toBe(`${fb} · verified · Vì sao bảng chỉ đọc?`);
    expect(n?.body ?? null).toBeNull();
  });

  it('verify-ask: the resolved fact, and no canned ask to confirm or reopen', async () => {
    const fb = await answered('bo', 'Lọc theo khoa?');
    ok(await say('owner', 'POST', item(fb, 'verify-ask'), {}));
    const [n] = (await bell('bo', fb)).filter((x) => x.type === 'feedback_verify_asked');
    expect(n?.title).toBe(`${fb} · resolved · Lọc theo khoa?`);
    expect(n?.body ?? null).toBeNull();
  });
});
