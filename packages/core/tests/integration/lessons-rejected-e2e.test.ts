// REQ-50 r2 BC-2, BC-8: a correction that is not one is rejected by the steward, with a reason, and
// is never linked, grouped or counted as a correction again; the month counts it apart. A row a person
// dismissed before 0522 reads the same way (lessons-steward-only-migration-e2e). Through the steward's
// pass and the lessons store against real Postgres, the model's answers the test's own.
//
// @direct-test-of packages/core/src/lessons/gather.ts
// @direct-test-of packages/core/src/lessons/month.ts

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { type Doc, ok } from '../helpers/ecosystem-world.js';
import { rows } from '../helpers/factories.js';
import {
  approve,
  at,
  correction,
  openLessonsWorld,
  ownProject,
  pass,
  proposal,
  say,
} from '../helpers/lessons-world.js';

openLessonsWorld();

const NOT_ONE = 'A judge probe naming no output, not a correction of one.';

/** Mark a correction rejected as the steward would have. */
async function reject(id: string, by: string): Promise<void> {
  await rows(
    sql`UPDATE corrections SET rejected_at = now(), rejected_by = ${by}, rejected_reason = ${NOT_ONE} WHERE id = ${id}`,
  );
}

const rowOf = async (id: string) =>
  (
    await rows<Doc>(
      sql`SELECT lesson_id, rejected_at, rejected_by, rejected_reason FROM corrections WHERE id = ${id}`,
    )
  )[0];

const lessonsIn = async (project: string) =>
  rows<{ number: number; sentence: string }>(
    sql`SELECT number, sentence FROM lessons WHERE project_id = ${project} ORDER BY number`,
  );

describe('a rejected correction feeds no lesson (BC-2)', () => {
  it('is never handed to the grouping, grouped into a proposal, or linked as a repeat', async () => {
    const own = await ownProject();
    const a = await correction('Slice by screen.', { project: own.id });
    const b = await correction('Slice by screen, again.', { project: own.id });
    const gone = await correction('Slice by screen, a probe.', { project: own.id });
    await reject(gone, own.stewardId);
    const asked: string[] = [];
    await pass({
      project: own.id,
      seen: (input) => asked.push(...input.corrections.map((c) => String(c.id))),
      proposals: [proposal('Slice a breakdown by screen.', [gone, a])],
      review: approve(),
    });
    expect(asked.sort()).toEqual([a, b].sort());
    expect(await lessonsIn(own.id)).toEqual([]);
    await pass({
      project: own.id,
      proposals: [proposal('Slice by screen.', [a, b])],
      review: approve(),
    });
    const [made] = await lessonsIn(own.id);
    await pass({ project: own.id, links: [{ correction: gone, lesson: Number(made?.number) }] });
    const { linkRepeats } = await import('../../src/lessons/index.js');
    expect(await linkRepeats(own.id, [{ correction: gone, lesson: Number(made?.number) }])).toBe(0);
    expect(await rowOf(gone)).toMatchObject({ lesson_id: null, rejected_reason: NOT_ONE });
  });

  it('is refused by name when a proposal names it', async () => {
    const own = await ownProject();
    const a = await correction('Name the ward.', { project: own.id });
    const gone = await correction('Name the ward, a probe.', { project: own.id });
    await reject(gone, own.stewardId);
    const { proposeLesson } = await import('../../src/lessons/index.js');
    const refused = await proposeLesson({
      projectId: own.id,
      actor: { userId: own.stewardId, agency: 'agent' },
      body: { sentence: 'Name the ward.', scope: { kind: 'project' }, corrections: [a, gone] },
    }).then(
      () => [],
      (err: { refusals?: { code: string; detail?: string }[] }) => err.refusals ?? [],
    );
    expect(refused.map((r) => r.code)).toEqual(['LESSON_CORRECTIONS_INVALID']);
    expect(refused[0]?.detail).toContain(gone);
  });
});

describe('the steward rejects a correction that is not one (BC-2)', () => {
  it('writes when, the steward and the reason, and groups the rest without it', async () => {
    const own = await ownProject();
    const a = await correction('Show the due date.', { project: own.id });
    const b = await correction('The due date is missing again.', { project: own.id });
    const probe = await correction('ping', { project: own.id });
    const tally = await pass({
      project: own.id,
      rejections: [
        { correction: probe, reason: NOT_ONE },
        // a rejection naming a correction the pass was not handed is left alone
        { correction: '00000000-0000-4000-8000-000000000000', reason: NOT_ONE },
      ],
      proposals: [proposal('Show the due date.', [a, b, probe])],
    });
    expect(tally).toMatchObject({ correctionsRejected: 1, proposed: 1 });
    expect(await rowOf(probe)).toMatchObject({
      lesson_id: null,
      rejected_by: own.stewardId,
      rejected_reason: NOT_ONE,
    });
    expect((await rowOf(probe))?.rejected_at).not.toBeNull();
    const [made] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM corrections c JOIN lessons l ON l.id = c.lesson_id WHERE l.project_id = ${own.id}`,
    );
    expect(made?.n).toBe(2);
    const asked: string[] = [];
    await pass({
      project: own.id,
      seen: (i) => asked.push(...i.corrections.map((c) => String(c.id))),
    });
    expect(asked).toEqual([]);
  });
});

describe('the month counts a rejected correction apart (BC-8)', () => {
  it('leaves it out of the corrections received and says how many the steward rejected', async () => {
    const own = await ownProject();
    await correction('Name the ward (1).', { project: own.id });
    await correction('Name the ward (2).', { project: own.id, source: 'verdict_failed' });
    await reject(await correction('ping', { project: own.id }), own.stewardId);
    const { lessonsMonth } = await import('../../src/lessons/index.js');
    expect(await lessonsMonth({ projectId: own.id })).toMatchObject({
      corrections: {
        total: 2,
        rejected: 1,
        bySource: { suggestion_rejected: 1, verdict_failed: 1 },
      },
    });
    await pass({ project: own.id });
    const slug = `lessons-month-${new Date().toISOString().slice(0, 7)}`;
    const read = ok(await say('owner', 'GET', at(`/knowledge/${slug}`, own.id)));
    const body = String(((read.entry ?? read) as Doc).body);
    expect(body).toContain('Corrections received: 2 (suggestion rejected 1, verdict failed 1)');
    expect(body).toContain('Rejected by the steward as not corrections: 1');
  });
});
