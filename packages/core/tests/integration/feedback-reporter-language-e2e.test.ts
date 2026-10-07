/**
 * Every notice a reporter gets about their item reads in their language: the person's own choice,
 * else the project's content language, else English. One notice kind per test: a decline, a merge
 * into an original, a triager's message (each reporter of a merged item in their own language), the
 * automatic verify, the ask to verify, and "tell the reporter now". The project here writes
 * Vietnamese; bo chose nothing and reads it, ann chose English and reads English.
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
import { seedProjectDocument } from '../helpers/release-world.js';

type Who = 'owner' | 'ann' | 'bo';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
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
  ok(await say('owner', 'POST', item(fb, 'triage'), { route: 'answer', answer: 'Theo thiết kế.' }));
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
  await closeWorld();
});

describe('a reporter reads each notice about their item in their language', () => {
  it('declined: in the project language for one who chose none, in English for one who chose it', async () => {
    const fb = await file('bo', 'Bảng mất bộ lọc');
    ok(
      await say('owner', 'POST', item(fb, 'triage'), { route: 'decline', note: 'Ngoài phạm vi.' }),
    );
    expect(await bell('bo', fb)).toEqual([
      {
        type: 'feedback_message',
        title: `${fb} đã bị từ chối: Bảng mất bộ lọc`,
        body: 'Mục này sẽ không được thực hiện.\nLý do: Ngoài phạm vi.',
      },
    ]);
    const en = await file('ann', 'Board drops its filter');
    ok(await say('owner', 'POST', item(en, 'triage'), { route: 'decline', note: 'Not planned.' }));
    expect((await bell('ann', en))[0]?.title, 'a chosen language wins over the project').toBe(
      `${en} was declined: Board drops its filter`,
    );
  });

  it('duplicate: told which item carries their report', async () => {
    const original = await file('owner', 'Xuất file chậm');
    const fb = await file('bo', 'Xuất file rất chậm');
    ok(
      await say('owner', 'POST', item(fb, 'triage'), { route: 'duplicate', duplicateOf: original }),
    );
    const [n] = await bell('bo', fb);
    expect(n?.title).toBe(`${fb}: Xuất file rất chậm đã được báo trước đó trong ${original}`);
    expect(n?.body).toBe(
      `Báo cáo của bạn đã được gộp vào ${original}. Bạn sẽ nhận tin về nó ở đó, và báo cáo của bạn vẫn được lưu lại.`,
    );
  });

  it('message: each reporter of a merged item gets it in their own language, the words as written', async () => {
    const fb = await file('bo', 'Thẻ bị trùng');
    const dup = await file('ann', 'Cards repeat');
    ok(await say('owner', 'POST', item(dup, 'triage'), { route: 'duplicate', duplicateOf: fb }));
    ok(
      await say('owner', 'POST', item(fb, 'messages'), {
        audience: 'all_reporters',
        text: 'Đang xem.',
      }),
      201,
    );
    const vi = (await bell('bo', fb)).filter((n) => n.title.startsWith('Tin nhắn'));
    expect(vi).toEqual([
      { type: 'feedback_message', title: `Tin nhắn về ${fb}: Thẻ bị trùng`, body: 'Đang xem.' },
    ]);
    const en = (await bell('ann', fb)).filter((n) => n.title.startsWith('A message'));
    expect(en).toEqual([
      { type: 'feedback_message', title: `A message about ${fb}: Thẻ bị trùng`, body: 'Đang xem.' },
    ]);
  });

  it('auto-verified: told Forge verified it after the window', async () => {
    const fb = await answered('bo', 'Vì sao bảng chỉ đọc?');
    await db.execute(sql`
      UPDATE feedback SET resolved_seen_at = now() - interval '60 days'
       WHERE project_id = ${projectId} AND fb_seq = ${seq(fb)}
    `);
    const { sweepResolvedFeedback } = await import('../../src/feedback/index.js');
    await sweepResolvedFeedback();
    const [n] = (await bell('bo', fb)).filter((x) => x.title.includes('xác nhận'));
    expect(n?.title).toBe(`${fb} đã được xác nhận: Vì sao bảng chỉ đọc?`);
    expect(n?.body).toMatch(
      /^Tự động xác nhận sau \d+ ngày không có phản hồi\. Nếu bản sửa chưa giải quyết điều bạn báo, hãy gửi lại thành một phản hồi mới\.$/,
    );
  });

  it('verify-ask: asked to confirm the fix', async () => {
    const fb = await answered('bo', 'Lọc theo khoa?');
    ok(await say('owner', 'POST', item(fb, 'verify-ask'), {}));
    const [n] = (await bell('bo', fb)).filter((x) => x.type === 'feedback_verify_asked');
    expect(n?.title).toBe(`${fb} đã được giải quyết: Lọc theo khoa?`);
    expect(n?.body).toContain('Hãy xác nhận bản sửa');
  });
});
