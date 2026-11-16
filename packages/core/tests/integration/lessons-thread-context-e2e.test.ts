// ISS-1251 (REQ-50 BC-1, BC-2): a correction is read against the thread it was said in, from capture
// to the drafted lesson. Replays the traced case: on 2026-11-16 the owner corrected Babo twice in an
// epod thread (02:21Z, 02:22Z) under Babo's 02:18Z post that the new epod errors were "bằng tiếng
// Việt". Both replies were read alone and folded into forge L-103, "Write assistant responses in the
// project's configured language", the misreading Babo itself made: the owner meant the epod product's
// CLI and theme messages. The posts below are rebuilt from that record (the correction reasons kept on
// dev, Babo's 02:18 post as measured); the model calls are the test's own, so what is proven is what
// each step is handed and keeps, not how a model reads it. Against real Postgres.
//
// @direct-test-of packages/core/src/lessons/correction-thread.ts
// @direct-test-of packages/core/src/lessons/consumers.ts
// @direct-test-of packages/core/src/lessons/gather.ts
// @direct-test-of packages/core/src/steward/lessons-pass.ts

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { ThreadPost } from '../../src/lessons/correction-thread.js';
import { rows } from '../helpers/factories.js';
import { lesson, openLessonsWorld, ownProject, pass } from '../helpers/lessons-world.js';

openLessonsWorld();

const BABO_0218 =
  'Đã thêm các thông báo lỗi mới cho CLI và theme của epod, bằng tiếng Việt như các thông báo cũ.';
const OWNER_0221 = 'Sai rồi, dùng ngôn ngữ theo cấu hình của project, mặc định là tiếng Anh.';
const BABO_0221 = 'Dạ, từ giờ em sẽ trả lời bằng ngôn ngữ cấu hình của project.';
const OWNER_0222 =
  'Không phải, ý anh là ngôn ngữ của epod: các thông báo của CLI và theme, không phải tin nhắn của em.';

/** The epod thread as the room stored it, each post's id by its time. */
async function epodThread(projectId: string) {
  const [conv] = await rows<{ id: string }>(sql`
    INSERT INTO conversations (adapter, external_id, shape, title)
    VALUES ('rocketchat', ${`iss1251-${randomUUID()}`}, 'group', 'Support thread')
    RETURNING id`);
  const conversationId = String(conv?.id);
  const posts: [string, 'assistant' | 'user', string, string | null][] = [
    ['0218', 'assistant', BABO_0218, null],
    ['0221', 'user', OWNER_0221, 'owner-key'],
    ['0221b', 'assistant', BABO_0221, null],
    ['0222', 'user', OWNER_0222, 'owner-key'],
  ];
  const ids: Record<string, string> = {};
  for (const [i, [at, role, content, key]] of posts.entries()) {
    const [row] = await rows<{ id: string }>(sql`
      INSERT INTO conversation_messages (conversation_id, seq, role, content, author_key, author_label)
      VALUES (${conversationId}, ${i + 1}, ${role}, ${content}, ${key}, ${key ? 'owner' : 'Babo'})
      RETURNING id`);
    ids[at] = String(row?.id);
  }
  void projectId;
  return { conversationId, ids };
}

/** Captures one reply through the room consumer, with the test's own reading; what it was handed. */
async function capture(
  projectId: string,
  t: Awaited<ReturnType<typeof epodThread>>,
  assistantAt: string,
  personAt: string,
  what: string,
) {
  const { correctionFromReply, chatClassifyPrompt } = await import(
    '../../src/lessons/consumers.js'
  );
  const handed: { thread: readonly ThreadPost[]; prompt: string }[] = [];
  const id = await correctionFromReply(
    {
      projectId,
      conversationId: t.conversationId,
      assistantMessageId: t.ids[assistantAt] as string,
      personMessageId: t.ids[personAt] as string,
    },
    { source: 'room', room: { id: randomUUID(), rid: '6a95265c70ac333f6394dcfc' } },
    async (_p, assistant, person, thread) => {
      handed.push({ thread, prompt: chatClassifyPrompt(assistant, person, thread) });
      return { correction: true, confidence: 0.99, what };
    },
  );
  return { id: String(id), handed: handed[0] };
}

describe('a correction is captured with the thread it answers (ISS-1251)', () => {
  it("hands the reading the posts before the reply, Babo's 02:18 post among them, and keeps the owner's words", async () => {
    const own = await ownProject();
    const t = await epodThread(own.id);
    const got = await capture(
      own.id,
      t,
      '0221b',
      '0222',
      "Babo read 'the project's language' as its own reply language; the owner meant epod's CLI and theme messages.",
    );
    expect(got.handed?.thread.map((p) => p.text)).toEqual([
      BABO_0218,
      OWNER_0221,
      BABO_0221,
      OWNER_0222,
    ]);
    expect(got.handed?.prompt).toContain('bằng tiếng Việt');
    expect(got.handed?.prompt).toContain('Read the thread first');
    const [kept] = await rows<{ reason: string }>(
      sql`SELECT reason FROM corrections WHERE id = ${got.id}`,
    );
    expect(kept?.reason).toContain('the owner meant epod');
  });
});

describe('the drafted lesson reads the thread and quotes the owner (ISS-1251)', () => {
  it('replays 02:21 and 02:22: the grouping is handed each thread and asked to quote, and the lesson says what the owner meant', async () => {
    const { groupingPrompt } = await import('../../src/steward/lessons-pass.js');
    const own = await ownProject();
    const t = await epodThread(own.id);
    const first = await capture(
      own.id,
      t,
      '0218',
      '0221',
      'The owner corrects the language of the new epod errors Babo added: they follow the project setting, English by default.',
    );
    const second = await capture(
      own.id,
      t,
      '0221b',
      '0222',
      "Babo read 'the project's language' as its own reply language; the owner meant epod's CLI and theme messages.",
    );
    const sentence =
      'Write epod\'s own CLI and theme messages in epod\'s configured language, English by default (owner: "ý anh là ngôn ngữ của epod: các thông báo của CLI và theme").';
    let prompt = '';
    await pass({
      project: own.id,
      seen: (input) => {
        prompt = groupingPrompt(input as never);
      },
      proposals: [
        {
          sentence,
          corrections: [first.id, second.id],
          about: 'app',
          scope: 'project',
          areaId: null,
          itemKind: null,
          supersedes: null,
        },
      ],
    });
    // each correction reaches the drafter with its thread and the owner's words
    expect(prompt).toContain(`Assistant: ${BABO_0218}`);
    expect(prompt).toContain(`Person (owner): ${OWNER_0222}`);
    expect(prompt).toContain('the `sentence` quotes their words');
    expect(prompt).toContain('reading unsure');
    const [made] = await rows<{ number: number }>(
      sql`SELECT number FROM lessons WHERE project_id = ${own.id} AND sentence = ${sentence}`,
    );
    const drafted = await lesson(Number(made?.number), own.id);
    expect(drafted.corrections).toHaveLength(2);
    expect(String(drafted.sentence)).toContain('epod');
    expect(String(drafted.sentence)).not.toMatch(/assistant responses/i);
  });
});
