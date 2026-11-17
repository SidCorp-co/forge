// ISS-1251 round 6: on forge-dev the steward's lessons pass moved nothing from 12:02Z on 2026-11-17.
// The first room reply that failed its own audit (support.audit, 12:02:35Z) was kept as a room
// correction whose source ref is `audit:<room>:<chat message id>`, and the pass read every room
// correction's thread by taking that ref as a conversation message's uuid: Postgres refused the cast,
// `gatherInput` threw, and the pass failed on the project at its first step, every ten minutes, so no
// confusion was settled, no invalidated lesson re-checked and no month figure recorded. The only
// trace was an error line in a container log nobody could read. Here the same correction stands in
// the project; one pass settles a held, invalid lesson's re-anchor confusion; and each pass leaves
// its outcome on the capabilities read: the step it stopped at, and every judge that gave no answer.
// Against real Postgres; the model answers are the test's own.
//
// @direct-test-of packages/core/src/lessons/correction-thread.ts
// @direct-test-of packages/core/src/lessons/gather.ts
// @direct-test-of packages/core/src/lessons/pass-report.ts
// @direct-test-of packages/core/src/steward/lessons-pass.ts
// @direct-test-of packages/core/src/steward/lessons-pass-report.ts
// @direct-test-of packages/core/src/metrics/capabilities.ts
// @direct-test-of packages/core/src/support/reply-audit/audit.ts

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ok } from '../helpers/ecosystem-world.js';
import { rows } from '../helpers/factories.js';
import {
  approve,
  at,
  correction,
  numberOf,
  openLessonsWorld,
  pass,
  proposal,
  say,
  w,
} from '../helpers/lessons-world.js';

openLessonsWorld();

const CARD = 'support.member';
const REPLY = 'Bấm "Lưu" để lưu thay đổi.';

/**
 * A room reply that failed its own audit, kept as `auditReply` keeps it: a room correction on the
 * reply's conversation, its source ref naming the room and the chat message id the reply was posted
 * under, which is no conversation message's uuid.
 */
async function auditCorrection(projectId: string): Promise<string> {
  const [conv] = await rows<{ id: string }>(sql`
    INSERT INTO conversations (adapter, external_id, shape, title)
    VALUES ('rocketchat', ${`iss1251-r6-${randomUUID()}`}, 'group', 'Support thread')
    RETURNING id`);
  const conversationId = String(conv?.id);
  const chatMessageId = `rc${randomUUID().replaceAll('-', '').slice(0, 15)}`;
  await rows(sql`
    INSERT INTO conversation_messages (conversation_id, seq, role, content, author_key, author_label)
    VALUES (${conversationId}, 1, 'user', 'Làm sao để lưu?', 'owner-key', 'owner')`);
  await rows(sql`
    INSERT INTO conversation_messages (conversation_id, seq, role, content, external_id, author_label)
    VALUES (${conversationId}, 2, 'assistant', ${REPLY}, ${chatMessageId}, 'Babo')`);
  const { db } = await import('../../src/db/client.js');
  const { recordCorrection, auditCorrectionRef } = await import('../../src/lessons/index.js');
  const id = await db.transaction((tx) =>
    recordCorrection(tx, {
      projectId,
      source: 'room',
      sourceRef: auditCorrectionRef(randomUUID(), chatMessageId),
      item: { kind: 'conversation', id: conversationId, key: 'Room 6a95265c70ac333f6394dcfc' },
      reason: 'A room reply failed its audit: no_ui_directions (it says "bấm ")',
      by: { userId: w.ownerId, agency: 'agent' },
      score: 1,
    }),
  );
  if (!id) throw new Error('the audit correction was not kept');
  return id;
}

/** A lesson the steward approved on `card:support.member`, then invalidated by a landing; its number. */
async function invalidOnMember(sentence: string): Promise<number> {
  const a = await correction(`${sentence} (1)`);
  const b = await correction(`${sentence} (2)`);
  await pass({
    proposals: [{ ...proposal(sentence, [a, b]), anchor: `card:${CARD}` }],
    review: (input) =>
      (input.lesson as { sentence: string }).sentence === sentence ? approve() : null,
  });
  const n = await numberOf(sentence);
  const { invalidateLessonsForChange } = await import('../../src/lessons/index.js');
  await invalidateLessonsForChange(w.projectId, {
    by: 'ISS-1251',
    paths: [],
    text: `Reworks ${CARD}.`,
  });
  return n;
}

const lessonRow = async (n: number) =>
  (
    await rows<{ status: string; anchor: string; invalid: boolean }>(
      sql`SELECT status, anchor, invalid_at IS NOT NULL AS invalid FROM lessons
           WHERE project_id = ${w.projectId} AND number = ${n}`,
    )
  )[0];

const passRead = async () => {
  const got = await say('member', 'GET', at('/metrics/capabilities'));
  ok(got, 200);
  return got.json.lessonsPass;
};

describe('a room audit correction no longer stops the lessons pass (forge-dev, 2026-11-17)', () => {
  it('settles a held, invalid lesson’s re-anchor confusion in one pass, the audit read against its reply', async () => {
    const n = await invalidOnMember('Link a beta issue to the beta web host, never its API host.');
    const audit = await auditCorrection(w.projectId);
    ok(
      await say('member', 'POST', at(`/lessons/${n}/confusions`), {
        kind: 'unclear',
        sides: {
          lesson: `anchored to card:${CARD}`,
          other: 'it is about the links a reply gives, not the member record: card:support.reply',
        },
        recommended: { resolution: 'keep' },
      }),
      201,
    );
    let gathered: { id: string; thread?: { text: string }[] } | undefined;
    const tally = await pass({
      seen: (input) => {
        gathered = input.corrections.find((c) => c.id === audit) as typeof gathered;
      },
      settle: {
        resolution: 'keep',
        sentence: null,
        anchor: 'card:support.reply',
        reason: 'It is about the links a reply gives.',
      },
    });
    expect(tally.settled).toBe(1);
    expect(await lessonRow(n)).toEqual({
      status: 'approved',
      anchor: 'card:support.reply',
      invalid: false,
    });
    // the audit is read against the reply it judged, found by the chat message id it names
    expect(gathered?.thread?.map((p) => p.text)).toEqual(['Làm sao để lưu?', REPLY]);
    const read = await passRead();
    expect(read.stopped).toBeNull();
    expect(read.tally.settled).toBe(1);
  });
});

describe('each pass leaves its outcome on the capabilities read', () => {
  it('names a judge that gave no answer, how often and why, never only in a log line', async () => {
    const n = await invalidOnMember('Name the member by the username the record keeps.');
    await pass({ recheck: null });
    expect((await lessonRow(n))?.invalid).toBe(true);
    const read = await passRead();
    expect(read.stopped).toBeNull();
    const recheck = read.unanswered.find((u: { judge: string }) => u.judge === 'recheck');
    expect(recheck?.count).toBeGreaterThanOrEqual(1);
  });

  it('names the step a pass stopped at, with its error, and the steps it finished', async () => {
    const { runLessonsPass } = await import('../../src/steward/lessons-pass.js');
    await correction('A correction the grouping is asked about.');
    const tally = await runLessonsPass({
      projectIds: [w.projectId],
      group: async () => {
        throw new Error('the gateway answered 502');
      },
    });
    expect(tally.failed).toBe(1);
    const read = await passRead();
    expect(read.stopped).toEqual({ step: 'group', error: 'the gateway answered 502' });
    expect(read.endedAt >= read.startedAt).toBe(true);
  });
});
