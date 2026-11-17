// ISS-1251 c10 and c4: a lesson is held by use and folded into its card, and no lesson is anchored to
// a card no door carries. On forge every lesson read applied 0: the applied door refused all four
// calls it was given, and the `Lessons applied:` line runs end their issue comments with was read by
// nothing, so no lesson could reach the fold. Here a lesson is applied three times the ways an agent
// says so (the door with the map's slug, its key, and the line on its issue comment), and the
// steward's pass folds it into its card as one delta and retires it. And a proposal or an anchor
// naming a card no door carries (L-113's `card:79bf44c4-…`) is refused by name. Against real Postgres
// through the app's routes, the outbox and the steward's pass; the model answers are the test's own.
//
// @direct-test-of packages/core/src/lessons/consumers.ts
// @direct-test-of packages/core/src/lessons/applied.ts
// @direct-test-of packages/core/src/lessons/anchor-card.ts
// @direct-test-of packages/core/src/lessons/decide.ts
// @direct-test-of packages/core/src/lessons-ports.ts
// @direct-test-of packages/core/src/steward/lessons-lifecycle.ts
// @direct-test-of packages/core/src/steward/lessons-pass.ts
// @direct-test-of packages/core/src/steward/lessons-review.ts
// @direct-test-of packages/core/src/lessons/confusions.ts
// @direct-test-of packages/core/src/lessons/lifecycle-reads.ts

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ok, requester, settleOutbox } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestIssue, createTestUser, rows } from '../helpers/factories.js';
import {
  approve,
  at,
  correction,
  lesson,
  numberOf,
  openLessonsWorld,
  pass,
  proposal,
  say,
  w,
} from '../helpers/lessons-world.js';
import { pairTestBox } from '../helpers/paired-box.js';

openLessonsWorld();

const CARD = 'support.member';
const LINE = 'When a writer’s roles read unknown and they are the owner → keep them as the owner.';

describe('a lesson is anchored only to a card a door carries (c4)', () => {
  it('drops a proposal naming a card no door carries, and refuses the anchor by name', async () => {
    const a = await correction('Keep reports to a summary (1)');
    const b = await correction('Keep reports to a summary (2)');
    const uuid = 'card:79bf44c4-3e7d-4830-a6c4-d1282fe3d05d';
    await pass({
      proposals: [{ ...proposal('Keep reports to a summary.', [a, b]), anchor: uuid }],
    });
    const [none] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM lessons WHERE project_id = ${w.projectId} AND anchor = ${uuid}`,
    );
    expect(none?.n).toBe(0);
    const { proposeLesson } = await import('../../src/lessons/index.js');
    await expect(
      proposeLesson({
        projectId: w.projectId,
        actor: { userId: w.stewardId, agency: 'agent' },
        body: {
          sentence: 'Keep reports to a summary.',
          scope: { kind: 'project' },
          about: 'process',
          anchor: uuid,
          corrections: [a, b],
        },
      }),
    ).rejects.toMatchObject({
      refusals: [expect.objectContaining({ code: 'LESSON_ANCHOR_UNKNOWN', path: '/anchor' })],
    });
  });

  it('shows the anchor step the cards nearest the lesson, never an example to copy', async () => {
    const { lessonsPorts } = await import('../../src/lessons/index.js');
    const { anchorPrompt } = await import('../../src/steward/lessons-lifecycle.js');
    const sentence = 'For beta issues, generate links using the beta web host, not its API host.';
    const near = await lessonsPorts().cardsLike(sentence, 12);
    expect(near.length).toBeGreaterThan(0);
    const prompt = anchorPrompt(
      { number: 55, sentence, anchor: null, failures: [] } as never,
      near,
    );
    expect(prompt).not.toContain('e.g. `card:support.member`');
    expect(prompt).toContain(`card:${near[0]?.id}`);
  });
});

describe('a confusion re-anchors a lesson its anchor does not describe (c4)', () => {
  it('keeps the lesson on the card the steward names, and refuses one no door carries', async () => {
    const sentence = 'For beta issues, link to the beta web host, never its API host.';
    const a = await correction(`${sentence} (1)`);
    const b = await correction(`${sentence} (2)`);
    await pass({
      proposals: [{ ...proposal(sentence, [a, b]), anchor: `card:${CARD}` }],
      review: (input) =>
        (input.lesson as { sentence: string }).sentence === sentence ? approve() : null,
    });
    const n = await numberOf(sentence);
    const raise = () =>
      say('member', 'POST', at(`/lessons/${n}/confusions`), {
        kind: 'unclear',
        sides: {
          lesson: `anchored to card:${CARD}`,
          other:
            'the member record says nothing about beta links; it is about the links a reply gives: card:support.requirements',
        },
        recommended: { resolution: 'keep' },
      });
    ok(await raise(), 201);
    const wrong = await pass({
      settle: {
        resolution: 'keep',
        sentence: null,
        anchor: 'card:no.such-card',
        reason: 'Re-anchored.',
      },
    });
    expect(wrong.settled).toBe(0);
    const anchorOf = async () =>
      (
        await rows<{ status: string; anchor: string }>(
          sql`SELECT status, anchor FROM lessons WHERE project_id = ${w.projectId} AND number = ${n}`,
        )
      )[0];
    expect((await anchorOf())?.anchor).toBe(`card:${CARD}`);
    // a card that is real but neither offered nor named is a guess, and waits (round 1's example)
    const guessed = await pass({
      settle: {
        resolution: 'keep',
        sentence: null,
        anchor: 'card:support.reply',
        reason: 'Guess.',
      },
    });
    expect(guessed.settled).toBe(0);
    expect((await anchorOf())?.anchor).toBe(`card:${CARD}`);
    await pass({
      settle: {
        resolution: 'keep',
        sentence: null,
        anchor: 'card:support.requirements',
        reason: 'It is about the links a reply gives.',
      },
    });
    expect(await anchorOf()).toEqual({ status: 'approved', anchor: 'card:support.requirements' });
  });
});

describe('a lesson applied three times is folded into its card and retired (c10)', () => {
  it('counts the door’s slug and key and an agent’s issue-comment line, never a person’s, then folds it', async () => {
    const sentence = 'Keep the owner’s roles in the member record before answering him.';
    const a = await correction(`${sentence} (1)`);
    const b = await correction(`${sentence} (2)`);
    await pass({
      proposals: [{ ...proposal(sentence, [a, b]), anchor: `card:${CARD}` }],
      review: (input) =>
        (input.lesson as { sentence: string }).sentence === sentence ? approve() : null,
    });
    const n = await numberOf(sentence);
    expect((await lesson(n)).status).toBe('approved');

    const agent = (await createTestUser({ kind: 'agent' })).id;
    await addProjectMember(w.projectId, agent, 'member');
    const { paneToken } = await pairTestBox(w.projectId, { pairedBy: w.ownerId, actsAs: agent });
    const box = requester((await import('../../src/index.js')).app, { box: paneToken as string });
    const issue = await createTestIssue(w.projectId, w.ownerId, 41, {
      status: 'in_progress',
      createdAt: new Date(),
    });

    // 1: the door, the lesson named as the map lists it
    const job = (ref: string) => ({ kind: 'job', ref });
    ok(
      await box('box', 'POST', at('/lessons/applied'), {
        lessons: [`lesson-${n}`],
        output: job('j-1'),
      }),
    );
    // 2: the run's report on its issue, ending with the line its orientation asks for
    const said = `Built and checked.\n\nLessons applied: L-${n}`;
    ok(
      await box('box', 'POST', `/api/issues/${issue.id}/comments`, { intent: 'note', body: said }),
      201,
    );
    // a person writing the same line applies nothing
    ok(
      await say('member', 'POST', `/api/issues/${issue.id}/comments`, {
        intent: 'note',
        body: said,
      }),
      201,
    );
    await settleOutbox();
    // 3: the door again, by its key, for another output
    ok(
      await box('box', 'POST', at('/lessons/applied'), { lessons: [`L-${n}`], output: job('j-2') }),
    );

    const used = await lesson(n);
    expect(used.applied_count).toBe(3);
    expect(used.applications.map((x) => [x.output_kind, x.output_ref]).sort()).toEqual([
      ['issue', issue.key],
      ['job', 'j-1'],
      ['job', 'j-2'],
    ]);

    const tally = await pass({
      fold: (l) =>
        (l as { number: number }).number === n
          ? {
              field: 'situation',
              op: 'add',
              text: LINE,
              replaces: null,
              reason: 'Applied three times, never corrected.',
            }
          : null,
      replay: (input) => ({
        fixed: (input as { failures: string[] }).failures.length,
        broken: [],
        reason: 'Its scenarios hold.',
      }),
    });
    expect(tally.folded).toBe(1);
    const row = await lesson(n);
    expect(row.status).toBe('retired');
    expect(String(row.decided_reason)).toContain(`Folded into card ${CARD} as a situation`);
    const { cardFreshness } = await import('../../src/lessons/index.js');
    const [fresh] = await cardFreshness([CARD]);
    expect(fresh?.proposedDeltas).toEqual([
      expect.objectContaining({ field: 'situation', op: 'add', text: LINE, fromLesson: `L-${n}` }),
    ]);
  });
});

// ISS-1251 round 5: dev.713's change to support.member invalidated the ten lessons wrongly anchored
// there; a confusion settled them back to approved but kept the invalid mark, and any confusion, even
// settled, barred the fold for good, so no re-anchored lesson could ever be folded
describe('a lesson a landing invalidated, re-anchored by a confusion, is valid and can fold', () => {
  it('clears the invalid mark on the settlement and lets three uses make it hold', async () => {
    const sentence = 'Answer a member by the roles the record keeps for them.';
    const a = await correction(`${sentence} (1)`);
    const b = await correction(`${sentence} (2)`);
    await pass({
      proposals: [{ ...proposal(sentence, [a, b]), anchor: `card:${CARD}` }],
      review: (input) =>
        (input.lesson as { sentence: string }).sentence === sentence ? approve() : null,
    });
    const n = await numberOf(sentence);
    const { db } = await import('../../src/db/client.js');
    const { lessonsThatHold } = await import('../../src/lessons/index.js');
    const { invalidateLessonIn } = await import('../../src/lessons/decide.js');
    const { lessonIn } = await import('../../src/lessons/read.js');
    await db.transaction(async (tx) =>
      invalidateLessonIn(tx, await lessonIn(tx, w.projectId, String(n)), 'a test changed it'),
    );
    ok(
      await say('member', 'POST', at(`/lessons/${n}/confusions`), {
        kind: 'unclear',
        sides: {
          lesson: 'as written it stands',
          other: 'it is about the replies a member gets: card:support.reply',
        },
        recommended: { resolution: 'keep' },
      }),
      201,
    );
    await pass({
      settle: {
        resolution: 'keep',
        sentence: null,
        anchor: 'card:support.reply',
        reason: 'Moved.',
      },
    });
    const [row] = await rows<{ status: string; anchor: string; invalid: boolean }>(
      sql`SELECT status, anchor, invalid_at IS NOT NULL AS invalid FROM lessons
           WHERE project_id = ${w.projectId} AND number = ${n}`,
    );
    expect(row).toEqual({ status: 'approved', anchor: 'card:support.reply', invalid: false });
    await db.execute(
      sql`UPDATE lessons SET applied_count = 3 WHERE project_id = ${w.projectId} AND number = ${n}`,
    );
    expect((await lessonsThatHold(w.projectId)).map((l) => l.number)).toContain(n);
  });
});

// ISS-1251 round 5: dev.713's change to support.member invalidated ten lessons wrongly anchored
// there, and the re-check, shown no card, could only readmit each where it stood
describe('a re-check moves a wrongly anchored lesson to a card it was offered (c4)', () => {
  it('readmits the lesson on the offered card its answer names, valid again', async () => {
    const sentence = 'Reply to a member with screenshots of the page they see.';
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
      by: 'ISS-77',
      paths: [],
      text: `Reworks ${CARD}: members carry roles.`,
    });
    let offered: { id: string }[] = [];
    await pass({
      recheck: (l) => {
        offered = (l as { offered: { id: string }[] }).offered;
        return offered[0]
          ? {
              verdict: 'readmit',
              sentence: null,
              anchor: `card:${offered[0].id}`,
              reason: 'It is about the reply, not the member record.',
            }
          : null;
      },
    });
    expect(offered.length).toBeGreaterThan(0);
    const [row] = await rows<{ status: string; anchor: string; invalid: boolean }>(
      sql`SELECT status, anchor, invalid_at IS NOT NULL AS invalid FROM lessons
           WHERE project_id = ${w.projectId} AND number = ${n}`,
    );
    expect(row).toEqual({ status: 'approved', anchor: `card:${offered[0]?.id}`, invalid: false });
  });
});
