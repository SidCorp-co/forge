// ISS-1251 §4, §5: what a lesson says does not outlive what it is about, and a lesson that holds
// moves into its card. A lesson names its anchor; a landing that touches the anchor invalidates it
// (held, kept, out of every map) in the landing's own consumer; the steward re-admits, edits or
// retires it; a lesson that holds is folded into its card as one delta and retired; and no change to
// a lesson's text is adopted that its replay does not show fixing what it came from. Against real
// Postgres through the outbox and the steward's pass, every model answer the test's own.
//
// @direct-test-of packages/core/src/lessons/anchors.ts
// @direct-test-of packages/core/src/lessons/lifecycle-reads.ts
// @direct-test-of packages/core/src/steward/lessons-lifecycle.ts
// @direct-test-of packages/core/src/steward/lessons-review.ts

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { emitEvent } from '../../src/outbox/index.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { rows } from '../helpers/factories.js';
import {
  approve,
  block,
  correction,
  lesson,
  numberOf,
  openLessonsWorld,
  pass,
  proposal,
  w,
} from '../helpers/lessons-world.js';

openLessonsWorld();

const WIDGET = 'packages/core/src/widgets/render.ts';

/** An approved lesson naming `anchor`, from two corrections; its number. */
async function approvedOn(sentence: string, anchor: string): Promise<number> {
  const a = await correction(`${sentence} (1)`);
  const b = await correction(`${sentence} (2)`);
  await pass({
    proposals: [{ ...proposal(sentence, [a, b]), anchor }],
    review: (input) =>
      (input.lesson as { sentence: string }).sentence === sentence ? approve() : null,
  });
  return numberOf(sentence);
}

/** An issue landed with its commit's paths, as the box reports them; its id and key. */
async function landed(seq: number, paths: string[], title = 'widget rework') {
  const issueId = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at, merged_commit_sha, merged_paths)
    VALUES (${issueId}, ${w.projectId}, ${seq}, ${title}, 'awaiting_release', ${w.ownerId}, now(),
            'abc1234def5678abc1234def5678abc1234def56',
            ${JSON.stringify({ commit: 'abc1234def5678abc1234def5678abc1234def56', changes: paths.map((path) => ({ path, change: 'modified' })) })}::jsonb)`);
  return issueId;
}

/** The kernel's word that the issue's landing was taken past `awaiting_release`, delivered to every consumer. */
async function landedMove(issueId: string) {
  await emitEvent(db, 'issue.transitioned', {
    entity: 'issue',
    id: issueId,
    projectId: w.projectId,
    issueId,
    from: 'awaiting_release',
    to: 'closed',
    machineVersion: 1,
    reason: null,
    actor: { type: 'user', id: w.ownerId, agency: 'agent' },
    at: new Date().toISOString(),
  });
  await settleOutbox(15_000);
}

const stateOf = async (n: number) => {
  const [row] = await rows<{ status: string; invalid_at: Date | null; invalid_by: string | null }>(
    sql`SELECT status, invalid_at, invalid_by FROM lessons WHERE project_id = ${w.projectId} AND number = ${n}`,
  );
  return row;
};
const every = { produces: ['issue', 'chat', 'requirement'], area: 'any' as const };

describe('a landing that touches a lesson’s anchor invalidates it (§5)', () => {
  it('holds the lesson anchored to the changed file, keeps it out of the map, and leaves the others served', async () => {
    const touched = await approvedOn('Render the widget once per frame.', `${WIDGET}:render`);
    const other = await approvedOn(
      'Name the unit beside every number.',
      'packages/core/src/units.ts',
    );
    expect(await block(every)).toContain(`lesson-${touched}, when`);

    await landedMove(await landed(71, [WIDGET, 'packages/core/src/widgets/index.ts']));

    expect(await stateOf(touched)).toMatchObject({
      status: 'held',
      invalid_by: `ISS-71 changed ${WIDGET}`,
    });
    expect((await stateOf(touched))?.invalid_at).not.toBeNull();
    expect(await stateOf(other)).toMatchObject({ status: 'approved', invalid_at: null });
    const map = await block(every);
    expect(map).not.toContain(`lesson-${touched}, when`);
    expect(map).toContain(`lesson-${other}, when`);
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
    expect((await stateOf(bc))?.status).toBe('held');
    expect((await stateOf(near))?.status).toBe('approved');
  });

  it('is re-admitted by the steward’s re-check, edited where the change moved it, and served again', async () => {
    const n = await approvedOn('Cache the widget layout.', `${WIDGET}:layout`);
    await landedMove(await landed(73, [WIDGET]));
    expect((await stateOf(n))?.status).toBe('held');
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
    expect(await stateOf(n)).toMatchObject({
      status: 'approved',
      invalid_at: null,
      invalid_by: null,
    });
    expect((await lesson(n)).sentence).toBe('Cache the widget layout per theme.');
    expect(await block(every)).toContain(`lesson-${n}, when`);
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
    expect((await stateOf(unshown))?.status).toBe('approved');
  });
});

describe('a lesson that holds is folded into its card and retired (§4)', () => {
  it('hands the card one delta, replayed first, and retires the lesson naming where it went', async () => {
    const n = await approvedOn(
      'Before answering someone, read who they are.',
      'card:support.member',
    );
    await db.execute(
      sql`UPDATE lessons SET applied_count = 3 WHERE project_id = ${w.projectId} AND number = ${n}`,
    );
    const { lessonsPorts, provideLessonsPorts } = await import('../../src/lessons/index.js');
    const before = lessonsPorts();
    const folded: { card: string; delta: unknown; by: string }[] = [];
    provideLessonsPorts({
      ...before,
      foldIntoCard: async (card, delta, by) => {
        folded.push({ card, delta, by });
        return { ok: true };
      },
    });
    try {
      const tally = await pass({
        fold: (l) =>
          (l as { number: number }).number === n
            ? {
                field: 'situation',
                op: 'add',
                text: 'When someone writes whom you have no record of → read the member record, then answer.',
                replaces: null,
                reason: 'Applied three times, never corrected.',
              }
            : null,
      });
      expect(tally.folded).toBe(1);
    } finally {
      provideLessonsPorts(before);
    }
    expect(folded).toEqual([
      {
        card: 'support.member',
        delta: {
          field: 'situation',
          op: 'add',
          text: 'When someone writes whom you have no record of → read the member record, then answer.',
        },
        by: `L-${n}`,
      },
    ]);
    const row = await lesson(n);
    expect(row.status).toBe('retired');
    expect(String(row.decided_reason)).toContain('Folded into card support.member as a situation');
  });

  it('waits, never retiring, while no card registry takes the fold', async () => {
    const n = await approvedOn('Record what you learn about a member.', 'card:support.member');
    await db.execute(
      sql`UPDATE lessons SET applied_count = 5 WHERE project_id = ${w.projectId} AND number = ${n}`,
    );
    const tally = await pass({
      fold: () => {
        throw new Error('no fold is asked while no card registry takes one');
      },
    });
    expect(tally.foldWaiting).toBeGreaterThanOrEqual(1);
    expect((await stateOf(n))?.status).toBe('approved');
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
