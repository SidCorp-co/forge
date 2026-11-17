// ISS-1251 §4, §5: what a lesson says does not outlive what it is about, and a lesson that holds
// moves into its card. A lesson names its anchor; a landing that touches the anchor invalidates it
// (held, kept, out of every map) in the landing's own consumer; the steward re-admits, edits or
// retires it; a lesson that holds is folded into its card as one delta and retired; and no change to
// a lesson's text is adopted that its replay does not show fixing what it came from. Against real
// Postgres through the outbox and the steward's pass, every model answer the test's own.
//
// @direct-test-of packages/core/src/lessons/anchors.ts
// @direct-test-of packages/core/src/issues/memory-reads.ts
// @direct-test-of packages/core/src/lessons/lifecycle-reads.ts
// @direct-test-of packages/core/src/steward/lessons-lifecycle.ts
// @direct-test-of packages/core/src/steward/lessons-review.ts
// @direct-test-of packages/core/src/steward/lessons-piles.ts
// @direct-test-of packages/core/src/lessons/card-freshness.ts
// @direct-test-of packages/core/src/lessons/scenario-replay.ts
// @direct-test-of packages/core/src/cleanup/gate-debt.ts

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { rows } from '../helpers/factories.js';
import {
  approve,
  at,
  block,
  correction,
  landed,
  landedMove,
  lesson,
  lessonState,
  numberOf,
  openLessonsWorld,
  pass,
  proposal,
  say,
  TEST_ANCHOR,
  w,
} from '../helpers/lessons-world.js';

openLessonsWorld();

const WIDGET = 'packages/core/src/widgets/render.ts';

/**
 * An approved lesson naming `anchor`, from two corrections; its number. A card this file's own
 * registry stands in for is named once the lesson stands, as a card a door carried when the lesson
 * was drafted, since a proposal naming a card no door carries is refused (ISS-1251 c4).
 */
async function approvedOn(sentence: string, anchor: string): Promise<number> {
  const a = await correction(`${sentence} (1)`);
  const b = await correction(`${sentence} (2)`);
  const drafted = anchor.startsWith('card:') ? TEST_ANCHOR : anchor;
  await pass({
    proposals: [{ ...proposal(sentence, [a, b]), anchor: drafted }],
    review: (input) =>
      (input.lesson as { sentence: string }).sentence === sentence ? approve() : null,
  });
  const n = await numberOf(sentence);
  await db.execute(
    sql`UPDATE lessons SET anchor = ${anchor} WHERE project_id = ${w.projectId} AND number = ${n}`,
  );
  return n;
}

const every = { produces: ['issue', 'chat', 'requirement'], area: 'any' as const };

describe('a landing that touches a lesson’s anchor invalidates it (§5)', () => {
  it('holds the lesson anchored to the changed file, keeps it out of the map, and leaves the others served', async () => {
    const touched = await approvedOn('Render the widget once per frame.', `${WIDGET}:render`);
    const other = await approvedOn(
      'Name the unit beside every number.',
      'packages/core/src/units.ts',
    );
    // a card's door lives in its module: forge_support's in packages/core/src/support
    const wide = await approvedOn('Read the member before you answer.', 'card:support.member');
    const ownTest = await approvedOn(
      'Plant the refusal first.',
      'packages/core/src/widgets/render.test.ts',
    );
    expect(await block(every)).toContain(`- lesson-${touched}:`);

    // a landing that changed only tests, and one file in its layout alone, changes no anchored
    // symbol, door or behaviour (forge-dev dev.701: ISS-1251's plain-agreement.test.ts and one
    // rewrapped throw in tool-description.ts held every support card's lessons)
    const reformat = 'packages/core/src/support/tool-description.ts';
    await landedMove(
      await landed(
        70,
        [
          'packages/core/src/support/plain-agreement.test.ts',
          'packages/core/tests/integration/support-room-e2e.test.ts',
          'packages/core/src/widgets/render.test.ts',
          reformat,
        ],
        [reformat],
      ),
    );
    expect(await lessonState(wide)).toMatchObject({ status: 'approved', invalid_at: null });
    // a lesson anchored to a test itself is met by that test's change
    expect((await lessonState(ownTest))?.status).toBe('held');

    // the same file changed in its tokens is a change to the card's door
    await landedMove(await landed(71, [WIDGET, reformat]));
    expect((await lessonState(wide))?.status).toBe('held');

    expect(await lessonState(touched)).toMatchObject({
      status: 'held',
      invalid_by: `ISS-71 changed ${WIDGET}`,
    });
    expect((await lessonState(touched))?.invalid_at).not.toBeNull();
    // read by its slug it says it is invalid and why, never plain verified (dev.701: lesson-99)
    const read = await say('member', 'GET', at(`/knowledge/lesson-${touched}`));
    expect(read.json).toMatchObject({
      confidence: 'deprecated',
      metadata: { invalid: true, invalidBy: `ISS-71 changed ${WIDGET}` },
    });
    expect(await lessonState(other)).toMatchObject({ status: 'approved', invalid_at: null });
    const map = await block(every);
    expect(map).not.toContain(`- lesson-${touched}:`);
    expect(map).toContain(`- lesson-${other}:`);
  });

  it('meets a requirement behaviour by the landing’s words, and nothing the landing does not name', async () => {
    const bc = await approvedOn('Show the cap beside the count.', 'REQ-50 BC-8');
    const near = await approvedOn('Show the month beside the count.', 'REQ-50 BC-80');
    const { invalidateLessonsForChange } = await import('../../src/lessons/index.js');
    const n = await invalidateLessonsForChange(w.projectId, {
      by: 'ISS-72',
      paths: [],
      text: 'Delivers REQ-50 BC-8: the cap is shown.',
    });
    expect(n).toBe(1);
    expect((await lessonState(bc))?.status).toBe('held');
    expect((await lessonState(near))?.status).toBe('approved');
  });

  it('is re-admitted by the steward’s re-check, edited where the change moved it, and served again', async () => {
    const n = await approvedOn('Cache the widget layout.', `${WIDGET}:layout`);
    await landedMove(await landed(73, [WIDGET]));
    expect((await lessonState(n))?.status).toBe('held');
    const tally = await pass({
      recheck: (l) =>
        (l as { number: number }).number === n
          ? {
              verdict: 'edit',
              sentence: 'Cache the widget layout per theme.',
              anchor: null,
              reason: 'The layout is per theme now.',
            }
          : null,
    });
    expect(tally.readmitted).toBeGreaterThanOrEqual(1);
    expect(await lessonState(n)).toMatchObject({
      status: 'approved',
      invalid_at: null,
      invalid_by: null,
    });
    expect((await lesson(n)).sentence).toBe('Cache the widget layout per theme.');
    const read = await say('member', 'GET', at(`/knowledge/lesson-${n}`));
    expect(read.json.confidence).toBe('verified');
    expect(read.json.metadata).not.toHaveProperty('invalid');
    expect(await block(every)).toContain(`- lesson-${n}:`);
  });

  it('is retired by the re-check when the change made it wrong, kept for its history', async () => {
    const n = await approvedOn('Pass the widget a frame id.', `${WIDGET}:frame`);
    await landedMove(await landed(74, [WIDGET]));
    await pass({
      recheck: (l) =>
        (l as { number: number }).number === n
          ? { verdict: 'retire', sentence: null, anchor: null, reason: 'Frames are gone.' }
          : null,
    });
    const row = await lesson(n);
    expect(row.status).toBe('retired');
    expect(String(row.decided_reason)).toContain('ISS-74');
  });
});

describe('an unanchored lesson is not admitted, and an old one is anchored from its record (§4)', () => {
  it('drops a proposed group naming no anchor, saying so', async () => {
    const a = await correction('Quote the owner (1).');
    const b = await correction('Quote the owner (2).');
    const tally = await pass({
      proposals: [{ ...proposal('Quote the owner.', [a, b]), anchor: null }],
    });
    expect(tally.dropped).toBeGreaterThanOrEqual(1);
    const [held] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM lessons WHERE project_id = ${w.projectId} AND sentence = 'Quote the owner.'`,
    );
    expect(held?.n).toBe(0);
  });

  it('anchors a lesson drafted before anchors where its record shows one, and lists one it does not', async () => {
    const shown = await approvedOn('Read who the member is first.', 'card:support.member');
    const unshown = await approvedOn('Be kind.', 'card:support.reply');
    await db.execute(
      sql`UPDATE lessons SET anchor = NULL WHERE project_id = ${w.projectId} AND number IN (${shown}, ${unshown})`,
    );
    const tally = await pass({
      anchor: (l) =>
        (l as { number: number }).number === shown
          ? {
              anchor: 'card:support.member',
              reason: 'Its corrections are about the member record.',
            }
          : { anchor: null, reason: 'Nothing in its record names what it is about.' },
    });
    const [after] = await rows<{ shown: string | null; unshown: string | null }>(sql`
      SELECT (SELECT anchor FROM lessons WHERE project_id = ${w.projectId} AND number = ${shown}) AS shown,
             (SELECT anchor FROM lessons WHERE project_id = ${w.projectId} AND number = ${unshown}) AS unshown`);
    expect(after).toEqual({ shown: 'card:support.member', unshown: null });
    expect(tally.unanchored).toBeGreaterThanOrEqual(1);
    expect((await lessonState(unshown))?.status).toBe('approved');
  });
});

describe('a lesson that holds is folded into its card and retired (§4)', () => {
  const CARD = 'iss1251.test-member';
  const LINE =
    'When someone writes whom you have no record of → read the member record, then answer.';

  const BEFORE_FOLD = [
    { when: 'someone asks about a member', do: 'answer from the member record' },
  ];

  const PRACTICE = 'Read the member record before you answer.';
  /** The card's two scenarios: each holds while the card says what its good use needs. */
  const SCENARIOS = [
    {
      name: 'asks-unknown-member',
      card: CARD,
      source: 'the lessons world',
      situation: 'a stranger writes',
      good: 'read the member record first',
      teaches: [/read the member record/i],
    },
    {
      name: 'answers-known-member',
      card: CARD,
      source: 'the lessons world',
      situation: 'a member asks about a member',
      good: 'answer from the member record',
      teaches: [/answer from the member record/i],
    },
  ];

  /** The steward's pass with a card registry that carries `CARD`, its scenarios and its situations. */
  async function passWithCard(answers: Parameters<typeof pass>[0], situations = BEFORE_FOLD) {
    const { lessonsPorts, provideLessonsPorts } = await import('../../src/lessons/index.js');
    const before = lessonsPorts();
    provideLessonsPorts({
      ...before,
      cardOf: async (id) =>
        id === CARD ? { id, scenarios: SCENARIOS, situations, practice: [PRACTICE] } : null,
    });
    try {
      return await pass(answers);
    } finally {
      provideLessonsPorts(before);
    }
  }

  it('proposes one delta to the card, keeps each scenario’s replay, and retires the lesson naming where it went', async () => {
    const n = await approvedOn('Before answering someone, read who they are.', `card:${CARD}`);
    await db.execute(
      sql`UPDATE lessons SET applied_count = 3 WHERE project_id = ${w.projectId} AND number = ${n}`,
    );
    const tally = await passWithCard({
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
        reason: 'Both scenarios hold.',
      }),
    });
    expect(tally.folded).toBe(1);
    const { cardFreshness } = await import('../../src/lessons/index.js');
    const [fresh] = await cardFreshness([CARD]);
    expect(fresh?.proposedDeltas).toEqual([
      expect.objectContaining({ field: 'situation', op: 'add', text: LINE, fromLesson: `L-${n}` }),
    ]);
    const runs = (fresh?.scenarios ?? []).map((x) => [x.name, x.passed, x.change]);
    expect(runs.sort()).toEqual([
      ['answers-known-member', true, `L-${n} fold`],
      ['asks-unknown-member', true, `L-${n} fold`],
    ]);
    const row = await lesson(n);
    expect(row.status).toBe('retired');
    expect(String(row.decided_reason)).toContain(`Folded into card ${CARD} as a situation`);
  });

  it('keeps a lesson whose fold breaks a scenario, and records the scenario failed', async () => {
    const n = await approvedOn('Never greet a member by name.', `card:${CARD}`);
    await db.execute(
      sql`UPDATE lessons SET applied_count = 4 WHERE project_id = ${w.projectId} AND number = ${n}`,
    );
    const tally = await passWithCard({
      fold: (l) =>
        (l as { number: number }).number === n
          ? {
              field: 'redFlag',
              op: 'add',
              text: 'Greeting a member by name.',
              replaces: null,
              reason: 'Held.',
            }
          : null,
      replay: () => ({
        fixed: 1,
        broken: ['answers-known-member'],
        reason: 'A known member is greeted by name.',
      }),
    });
    expect(tally.replayRefused).toBeGreaterThanOrEqual(1);
    expect((await lessonState(n))?.status).toBe('approved');
    const { cardFreshness } = await import('../../src/lessons/index.js');
    const [fresh] = await cardFreshness([CARD]);
    expect(fresh?.scenarios.find((x) => x.name === 'answers-known-member')).toMatchObject({
      passed: false,
      change: `L-${n} fold`,
    });
  });

  it('refuses a fold that drops what a scenario needs, though the model’s replay adopts it', async () => {
    const n = await approvedOn('Answer before reading any record.', `card:${CARD}`);
    await db.execute(
      sql`UPDATE lessons SET applied_count = 3 WHERE project_id = ${w.projectId} AND number = ${n}`,
    );
    const tally = await passWithCard({
      fold: (l) =>
        (l as { number: number }).number === n
          ? {
              field: 'bestPractice',
              op: 'update',
              text: 'Answer at once.',
              replaces: PRACTICE,
              reason: 'Applied three times.',
            }
          : null,
      replay: (input) => ({
        fixed: (input as { failures: string[] }).failures.length,
        broken: [],
        reason: 'Nothing breaks.',
      }),
    });
    expect(tally.replayRefused).toBeGreaterThanOrEqual(1);
    expect((await lessonState(n))?.status).toBe('approved');
    const { cardFreshness } = await import('../../src/lessons/index.js');
    const [fresh] = await cardFreshness([CARD]);
    expect(fresh?.scenarios.find((x) => x.name === 'asks-unknown-member')).toMatchObject({
      passed: false,
      change: `L-${n} fold`,
    });
    expect(fresh?.proposedDeltas.map((d) => d.text)).not.toContain('Answer at once.');
  });

  it('applies a proposed delta at the card’s re-check once its code carries the line, and not before', async () => {
    const { cardFreshness } = await import('../../src/lessons/index.js');
    const proposed = async () =>
      ((await cardFreshness([CARD]))[0]?.proposedDeltas ?? []).map((d) => d.text);
    expect(await proposed()).toContain(LINE);
    expect((await passWithCard({})).deltasApplied).toBe(0);
    expect(await proposed()).toContain(LINE);
    const carried = [
      ...BEFORE_FOLD,
      {
        when: 'someone writes whom you have no record of',
        do: 'Read the member record, then answer',
      },
    ];
    const tally = await passWithCard({}, carried);
    expect(tally.deltasApplied).toBe(1);
    expect(await proposed()).not.toContain(LINE);
    const [row] = await rows<{ status: string }>(
      sql`SELECT status FROM card_deltas WHERE card_id = ${CARD} AND text = ${LINE}`,
    );
    expect(row?.status).toBe('applied');
  });

  it('waits, never retiring, while no door carries the card it names', async () => {
    const n = await approvedOn('Record what you learn about a member.', 'card:no.such-card');
    await db.execute(
      sql`UPDATE lessons SET applied_count = 5 WHERE project_id = ${w.projectId} AND number = ${n}`,
    );
    const tally = await passWithCard({
      fold: (l) => {
        if ((l as { number: number }).number === n) {
          throw new Error('no fold is asked for a card no door carries');
        }
        return null;
      },
    });
    expect(tally.foldWaiting).toBeGreaterThanOrEqual(1);
    expect((await lessonState(n))?.status).toBe('approved');
  });
});

describe('a landing touching a card-anchored lesson marks the card owed a re-check (§5)', () => {
  it('holds the lesson and owes the card a re-check, naming the landing', async () => {
    const n = await approvedOn('Read the member before you answer.', 'card:iss1251.recheck-card');
    const { invalidateLessonsForChange, cardFreshness } = await import(
      '../../src/lessons/index.js'
    );
    await invalidateLessonsForChange(w.projectId, {
      by: 'ISS-75',
      paths: [],
      text: 'Reworks iss1251.recheck-card: members carry roles.',
    });
    expect((await lessonState(n))?.status).toBe('held');
    const [fresh] = await cardFreshness(['iss1251.recheck-card']);
    expect(fresh?.recheckOwed).toMatchObject({ by: 'ISS-75 changed card:iss1251.recheck-card' });
  });

  it('clears the card once the steward re-checked every lesson on it, and not before', async () => {
    const CARD = 'iss1251.recheck-two';
    const first = await approvedOn('Greet the member by role.', `card:${CARD}`);
    const second = await approvedOn('Show the member role in the header.', `card:${CARD}`);
    const { invalidateLessonsForChange, cardFreshness } = await import(
      '../../src/lessons/index.js'
    );
    await invalidateLessonsForChange(w.projectId, {
      by: 'ISS-76',
      paths: [],
      text: `Reworks ${CARD}: roles are named.`,
    });
    const readmit = (only: number[]) => (l: unknown) =>
      only.includes((l as { number: number }).number)
        ? { verdict: 'readmit', sentence: null, anchor: null, reason: 'Roles still show.' }
        : null;
    const once = await pass({ recheck: readmit([first]) });
    expect(once.cardsRechecked).toBe(0);
    expect((await cardFreshness([CARD]))[0]?.recheckOwed).not.toBeNull();
    const twice = await pass({ recheck: readmit([second]) });
    expect(twice.cardsRechecked).toBe(1);
    expect((await cardFreshness([CARD]))[0]?.recheckOwed).toBeNull();
    expect((await lessonState(second))?.status).toBe('approved');
  });
});

// ISS-1251 round 5: dev.713's change to support.member invalidated ten lessons wrongly anchored
// there, and the re-check, shown no card, could only readmit each where it stood
describe('a re-check moves a wrongly anchored lesson to a card it was offered (c4)', () => {
  it('readmits the lesson on the offered card its answer names, valid again', async () => {
    const CARD = 'iss1251.recheck-wrong';
    const n = await approvedOn('Reply to a member with screenshots of the page they see.', `card:${CARD}`);
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

describe('a pile past its cap opens one consolidation item, never a cut (§5)', () => {
  it('records one simplify debt for the always-on knowledge, once across passes, and cuts no entry', async () => {
    const { ALWAYS_INJECT_MAX_CHARS } = await import('@forge/contracts/knowledge');
    const body = 'Every prompt carries this line about the ward rota. '.repeat(40);
    const slugs: string[] = [];
    for (let i = 0; slugs.length * body.length <= ALWAYS_INJECT_MAX_CHARS; i++) {
      slugs.push(`ward-rota-${i}`);
      await rows(sql`
        INSERT INTO knowledge_entries (project_id, slug, title, body, kind, injection)
        VALUES (${w.projectId}, ${`ward-rota-${i}`}, ${`Ward rota ${i}`}, ${body}, 'guide', 'always')
        RETURNING id`);
    }
    const first = await pass({});
    const second = await pass({});
    expect(first.consolidations).toBeGreaterThanOrEqual(1);
    const debts = await rows<{ kind: string; location: string; detail: string }>(sql`
      SELECT kind, location, detail FROM delivery_debts
       WHERE project_id = ${w.projectId} AND check_name = 'pile:always_knowledge'`);
    expect(debts).toHaveLength(1);
    expect(debts[0]).toMatchObject({ kind: 'simplify', location: 'always-on knowledge' });
    expect(debts[0]?.detail).toContain(`of ${ALWAYS_INJECT_MAX_CHARS} characters`);
    expect(second.consolidations).toBe(0);
    const [kept] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM knowledge_entries
       WHERE project_id = ${w.projectId} AND slug LIKE 'ward-rota-%' AND archived_at IS NULL AND body = ${body}`);
    expect(kept?.n).toBe(slugs.length);
  });
});

describe('replay before adopt (§5)', () => {
  it('rejects a proposal whose replay fixes none of the failures it came from, saying so', async () => {
    const a = await correction('Says the export moved (1).');
    const b = await correction('Says the export moved (2).');
    const sentence = 'Be careful with exports.';
    await pass({
      proposals: [{ ...proposal(sentence, [a, b]) }],
      review: (input) =>
        (input.lesson as { sentence: string }).sentence === sentence ? approve() : null,
      replay: (input) =>
        (input as { change: string }).change === sentence
          ? { fixed: 0, broken: [], reason: 'It names no place, so the same answer goes out.' }
          : { fixed: (input as { failures: string[] }).failures.length, broken: [], reason: 'ok' },
    });
    const row = await lesson(await numberOf(sentence));
    expect(row.status).toBe('rejected');
    expect(String(row.decided_reason)).toContain('Replay did not adopt it: fixed 0 of 2 failures');
  });
});
