// REQ-50 BC-5..BC-8: a confusion holds its lesson until a person decides, and is raised in Needs you
// with both sides and its recommendation; a repeat, or three corrections, becomes a check; an unused
// or superseded lesson is proposed for retirement, never deleted; and the monthly read counts all of
// it. Through the app's own routes against real Postgres (`../helpers/lessons-world.ts`).
//
// @direct-test-of packages/core/src/lessons/confusions.ts
// @direct-test-of packages/core/src/lessons/gather.ts
// @direct-test-of packages/core/src/lessons/month.ts
// @direct-test-of packages/core/src/development/needs-you-lessons.ts

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { type Doc, ok } from '../helpers/ecosystem-world.js';
import { createTestProject, rows, seedIssueStatus } from '../helpers/factories.js';
import {
  approved,
  at,
  block,
  codes,
  correction,
  lesson,
  openLessonsWorld,
  pass,
  proposal,
  proposed,
  say,
  w,
} from '../helpers/lessons-world.js';

openLessonsWorld();

/** The lesson decisions the Needs you read offers this viewer. */
const decisions = async (who: 'owner' | 'member') =>
  (ok(await say(who, 'GET', at('/needs-you/decisions'))).decisions as Doc[]).filter(
    (d) => d.topic === 'lesson',
  );

/** Presses one answer of a decision as the owner: its own path and body. */
const press = async (d: Doc | undefined, id: string) => {
  const a = ((d as Doc).answers as Doc[]).find((x) => x.id === id) as Doc;
  return ok(await say('owner', 'POST', a.path as string, a.body ?? {})).lesson as Doc;
};

describe('on confusion the agent stops, and the lesson is held until a person decides (BC-5)', () => {
  it('raises it in Needs you with both sides and the recommendation, and its button decides it', async () => {
    const n = await approved('Sign letters by the ward sister.');
    const other = await approved('Sign letters by the consultant.');
    ok(
      await say('member', 'POST', at(`/lessons/${n}/confusions`), {
        kind: 'conflict',
        other: { lesson: other },
        sides: { lesson: 'The ward sister signs.', other: 'The consultant signs.' },
        recommended: {
          resolution: 'edit',
          sentence: 'Discharge letters are signed by the consultant.',
        },
      }),
      201,
    );
    const asked = (await decisions('owner')).find((d) => d.key === `L-${n}`);
    expect(asked).toMatchObject({
      group: 'answer',
      entity: 'lesson',
      opens: { kind: 'lesson', key: `L-${n}` },
      recommended: { answerId: 'edit', by: 'asker' },
    });
    expect(asked?.question).toContain('The ward sister signs.');
    expect(asked?.question).toContain(`(L-${other}): The consultant signs.`);
    expect(((asked as Doc).answers as Doc[]).map((a) => [a.id, a.recommended])).toEqual([
      ['keep', false],
      ['edit', true],
      ['retire', false],
    ]);
    expect((await decisions('member')).find((d) => d.key === `L-${n}`)).toBeUndefined();
    expect(await press(asked, 'edit')).toMatchObject({
      status: 'approved',
      sentence: 'Discharge letters are signed by the consultant.',
    });
    expect((await decisions('owner')).find((d) => d.key === `L-${n}`)).toBeUndefined();
  });

  it('lists a proposed lesson to approve or reject, to whoever may decide it', async () => {
    const p = await proposed('Name the ward sister on every letter.');
    const asked = (await decisions('owner')).find((d) => d.key === p.key);
    expect(asked).toMatchObject({
      group: 'approve',
      recommended: null,
      proposal: { verb: 'Approve lesson' },
    });
    // the Reject is the answer the page's Decline presses: it declines and asks why (ISS-539)
    expect(((asked as Doc).answers as Doc[]).map((a) => [a.id, a.needsReason, a.declines])).toEqual(
      [
        ['approve', false, false],
        ['decline', true, true],
      ],
    );
    expect((await decisions('member')).find((d) => d.key === p.key)).toBeUndefined();
    expect((await press(asked, 'approve')).status).toBe('approved');
  });

  it('holds on raise, then keep, edit and retire each decide it', async () => {
    const n = await approved('Print letters in large type.');
    const other = await approved('Print letters in the house style.');
    const conflict = {
      kind: 'conflict',
      other: { lesson: other },
      sides: { lesson: 'Large type asks 16pt.', other: 'House style is 11pt.' },
      recommended: { resolution: 'edit', sentence: 'Print patient letters in large type.' },
    };
    expect(
      codes(
        await say('member', 'POST', at(`/lessons/${n}/confusions`), {
          ...conflict,
          other: undefined,
        }),
      ),
    ).toEqual(['LESSON_CONFUSION_INVALID']);
    const held = ok(await say('member', 'POST', at(`/lessons/${n}/confusions`), conflict), 201)
      .lesson as Doc;
    expect(held.status).toBe('held');
    expect(await block({ produces: ['issue'], area: 'any' })).not.toContain(`L-${n} `);
    const open = (ok(await say('owner', 'GET', at('/lessons'))).confusions as Doc[]).find(
      (c) => c.lessonKey === `L-${n}`,
    );
    expect(open).toMatchObject({
      kind: 'conflict',
      other: { lessonKey: `L-${other}` },
      sides: conflict.sides,
      recommended: conflict.recommended,
    });
    expect(
      (
        await say('member', 'POST', at(`/lessons/confusions/${open?.id}/decide`), {
          resolution: 'keep',
        })
      ).status,
    ).toBe(403);
    const kept = ok(
      await say('owner', 'POST', at(`/lessons/confusions/${open?.id}/decide`), {
        resolution: 'keep',
      }),
    ).lesson as Doc;
    expect(kept.status).toBe('approved');
    expect(await block({ produces: ['issue'], area: 'any' })).toContain(`L-${n} `);

    ok(await say('member', 'POST', at(`/lessons/${n}/confusions`), conflict), 201);
    const second = (ok(await say('owner', 'GET', at('/lessons'))).confusions as Doc[]).find(
      (c) => c.lessonKey === `L-${n}`,
    );
    const edited = ok(
      await say('owner', 'POST', at(`/lessons/confusions/${second?.id}/decide`), {
        resolution: 'edit',
      }),
    ).lesson as Doc;
    expect(edited).toMatchObject({
      status: 'approved',
      sentence: 'Print patient letters in large type.',
    });
    expect(await block({ produces: ['issue'], area: 'any' })).toContain(
      'Print patient letters in large type.',
    );

    ok(
      await say('member', 'POST', at(`/lessons/${n}/confusions`), {
        ...conflict,
        kind: 'unclear',
        other: undefined,
        recommended: { resolution: 'retire' },
      }),
      201,
    );
    const third = (ok(await say('owner', 'GET', at('/lessons'))).confusions as Doc[]).find(
      (c) => c.lessonKey === `L-${n}`,
    );
    const retired = ok(
      await say('owner', 'POST', at(`/lessons/confusions/${third?.id}/decide`), {
        resolution: 'retire',
      }),
    ).lesson as Doc;
    expect(retired.status).toBe('retired');
    expect(await block({ produces: ['issue'], area: 'any' })).not.toContain(
      'Print patient letters in large type.',
    );
    expect(codes(await say('member', 'POST', at(`/lessons/${n}/confusions`), conflict))).toEqual([
      'LESSON_DECIDED',
    ]);
    expect((await lesson(n)).confusions).toHaveLength(3);
  });
});

describe('a repeat, or three corrections, becomes a check in code (BC-6)', () => {
  const checkOf = async (id: string) =>
    rows<{ id: string; title: string; status: string }>(sql`
      SELECT id, title, status FROM issues WHERE project_id = ${w.projectId} AND detector_key = ${`lesson-check/${id}`}`);

  it('files one draft check for a lesson corrected again after approval, and never again, even once dropped', async () => {
    const n = (await proposed('Show the ward on the wristband.')).number as number;
    ok(await say('owner', 'POST', at(`/lessons/${n}/approve`), {}));
    const repeat = await correction('The wristband has no ward again.');
    await pass({ links: [{ correction: repeat, lesson: n }] });
    const view = await lesson(n);
    expect(view.repeats).toBe(1);
    expect(view.corrections).toHaveLength(2);
    expect(view.checkIssueKey).toMatch(/^[A-Z]+-\d+$/);
    const [issue] = await checkOf(view.id as string);
    expect(issue).toMatchObject({
      status: 'draft',
      title: 'Add a check: Show the ward on the wristband.',
    });
    expect((await pass({})).checks).toBe(0);
    await seedIssueStatus(issue?.id as string, 'dropped');
    expect((await pass({})).checks).toBe(0);
    expect(await checkOf(view.id as string)).toHaveLength(1);
  });

  it('files a check for a lesson learned from three corrections, and none for one learned from two', async () => {
    const two = await approved('Name the ward in the letter subject.');
    const three = [
      await correction('Bed is missing (1)'),
      await correction('Bed is missing (2)'),
      await correction('Bed is missing (3)'),
    ];
    await pass({ proposals: [proposal('Name the bed in every handover.', three)] });
    const n = (ok(await say('owner', 'GET', at('/lessons'))).lessons as Doc[]).find(
      (l) => l.sentence === 'Name the bed in every handover.',
    )?.number as number;
    ok(await say('owner', 'POST', at(`/lessons/${n}/approve`), {}));
    await pass({});
    expect((await lesson(n)).checkIssueKey).toMatch(/^[A-Z]+-\d+$/);
    expect((await lesson(n)).repeats).toBe(0);
    expect((await lesson(two)).checkIssueKey).toBeNull();
  });
});

describe('an unused or superseded lesson is proposed for retirement, never deleted (BC-7)', () => {
  it('proposes retiring one unused for 30 days, and keeping it restarts the clock', async () => {
    const n = await approved('Greet the patient by name.');
    await rows(
      sql`UPDATE lessons SET approved_at = now() - interval '31 days' WHERE project_id = ${w.projectId} AND number = ${n}`,
    );
    await pass({});
    expect((await lesson(n)).retire).toMatchObject({ reason: 'unused' });
    const asked = (await decisions('owner')).find((d) => d.key === `L-${n}`);
    expect(asked).toMatchObject({
      group: 'approve',
      recommended: { answerId: 'approve', by: 'rule' },
    });
    expect((asked as Doc).answers).toEqual([
      expect.objectContaining({
        id: 'approve',
        label: 'Retire',
        needsReason: false,
        body: { reason: 'No agent applied it in 30 days.' },
      }),
      expect.objectContaining({ id: 'keep', label: 'Keep' }),
    ]);
    const kept = await press(asked, 'keep');
    expect(kept.retire).toBeNull();
    expect((await decisions('owner')).find((d) => d.key === `L-${n}`)).toBeUndefined();
    await pass({});
    expect((await lesson(n)).retire).toBeNull();
  });

  it('proposes retiring a superseded one; retiring keeps the row', async () => {
    const old = await approved('Letters go out by post.');
    const a = await correction('Send letters by email (1).');
    const b = await correction('Send letters by email (2).');
    const made = ok(
      await say('owner', 'POST', at('/lessons'), {
        sentence: 'Letters go out by email.',
        scope: { kind: 'project' },
        corrections: [a, b],
        supersedes: old,
      }),
      201,
    ).lesson as Doc;
    ok(await say('owner', 'POST', at(`/lessons/${made.number}/approve`), {}));
    expect(await lesson(old)).toMatchObject({
      supersededBy: made.key,
      retire: { reason: 'superseded' },
    });
    ok(await say('owner', 'POST', at(`/lessons/${old}/retire`), { reason: 'Replaced by email.' }));
    expect(await lesson(old)).toMatchObject({ status: 'retired', reason: 'Replaced by email.' });
  });
});

describe('the monthly read (BC-8)', () => {
  it('counts the month: corrections by source, approvals, repeats and confusions with time to decision', async () => {
    const other = (await createTestProject(w.ownerId)).id;
    const sep = (d: number, h = 9) => new Date(Date.UTC(2026, 8, d, h));
    await correction('a', { project: other, at: sep(2) });
    await correction('b', { project: other, at: sep(3) });
    await correction('c', { project: other, at: sep(4), source: 'verdict_failed' });
    await correction('out of month', { project: other, at: new Date(Date.UTC(2026, 9, 1)) });
    const [l] = await rows<{ id: string }>(sql`
      INSERT INTO lessons (project_id, number, sentence, scope_kind, status, proposed_by, proposed_agency, approved_at)
      VALUES (${other}, 1, 'One lesson.', 'project', 'proposed', ${w.ownerId}, 'human', NULL) RETURNING id`);
    await rows(
      sql`UPDATE corrections SET lesson_id = ${l?.id}, linked_at = now() WHERE project_id = ${other} AND reason IN ('a', 'c')`,
    );
    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    const { db } = await import('../../src/db/client.js');
    await withKernelMarker(db, (tx) =>
      tx.execute(
        sql`UPDATE lessons SET status = 'approved', approved_at = ${sep(3, 12).toISOString()}::timestamptz WHERE id = ${l?.id}`,
      ),
    );
    await rows(sql`
      INSERT INTO lesson_confusions (project_id, lesson_id, kind, side_lesson, side_other, recommended, raised_agency, raised_at, decided_at, resolution)
      VALUES (${other}, ${l?.id}, 'unclear', 's1', 's2', 'keep', 'agent', ${sep(5, 9).toISOString()}::timestamptz, ${sep(5, 15).toISOString()}::timestamptz, 'keep'),
             (${other}, ${l?.id}, 'conflict', 's1', 's2', 'keep', 'agent', ${sep(20).toISOString()}::timestamptz, NULL, NULL)`);
    const read = ok(await say('owner', 'GET', at('/lessons/month?month=2026-09', other)));
    expect(read).toMatchObject({
      month: '2026-09',
      corrections: { total: 3, bySource: { suggestion_rejected: 2, verdict_failed: 1, chat: 0 } },
      lessonsApproved: 1,
      repeats: 1,
      confusions: { raised: 2, decided: 1, open: 1 },
    });
    expect((read.confusions.items as Doc[]).find((i) => i.kind === 'unclear')?.hours).toBe(6);
    expect(codes(await say('owner', 'GET', at('/lessons/month?month=2026-13', other)))).toEqual([
      'BAD_REQUEST',
    ]);
  });
});
