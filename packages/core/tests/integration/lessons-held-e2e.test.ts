// REQ-50 r2 BC-5..BC-9: a confusion an agent reports holds its lesson until the steward settles it,
// with a reason and no person asked, and nothing of a lesson reaches Needs you or the status read; a
// repeat, or three corrections, becomes a check; the steward retires an unused or superseded lesson
// with a reason, never deleting it; and core counts the month. Through the app's own routes against
// real Postgres (`../helpers/lessons-world.ts`).
//
// @direct-test-of packages/core/src/lessons/confusions.ts
// @direct-test-of packages/core/src/lessons/gather.ts
// @direct-test-of packages/core/src/lessons/month.ts
// @direct-test-of packages/core/src/development/needs-you-fold.ts
// @direct-test-of packages/core/src/project-status/lead.ts

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { type Doc, ok } from '../helpers/ecosystem-world.js';
import { createTestProject, rows, seedIssueStatus } from '../helpers/factories.js';
import {
  approve,
  approved,
  at,
  block,
  codes,
  correction,
  lesson,
  moves,
  numberOf,
  openLessonsWorld,
  ownProject,
  pass,
  proposal,
  proposed,
  say,
  settled,
  w,
} from '../helpers/lessons-world.js';

openLessonsWorld();

const conflictOn = (other: number) => ({
  kind: 'conflict',
  other: { lesson: other },
  sides: { lesson: 'Large type asks 16pt.', other: 'House style is 11pt.' },
  recommended: { resolution: 'edit', sentence: 'Print patient letters in large type.' },
});

/** A settlement for the confusions on lesson `n` alone; every other one gets no answer. */
const on = (n: number, answer: Doc) => (input: Doc) =>
  ((input.confusion as Doc).lesson as Doc).number === n ? answer : null;

describe('on confusion the agent stops, and the steward settles it with no person asked (BC-5)', () => {
  it('holds on report, then the steward keeps, edits and retires it, each with a reason the kernel keeps', async () => {
    const n = await approved('Print letters in large type.');
    const other = await approved('Print letters in the house style.');
    expect(
      codes(
        await say('member', 'POST', at(`/lessons/${n}/confusions`), {
          ...conflictOn(other),
          other: undefined,
        }),
      ),
    ).toEqual(['LESSON_CONFUSION_INVALID']);
    const raised = ok(
      await say('member', 'POST', at(`/lessons/${n}/confusions`), conflictOn(other)),
      201,
    );
    expect(raised).toEqual({ lesson: { key: `L-${n}`, status: 'held' } });
    expect(await block({ produces: ['issue'], area: 'any' })).not.toContain(`L-${n} `);

    // the steward reads both sides and the recommendation, and keeps it
    const asked: Doc[] = [];
    const kept = await pass({
      settle: (input) => {
        asked.push(input);
        return on(n, settled('keep', 'The house style yields to large type for patients.'))(input);
      },
    });
    expect(kept.settled).toBeGreaterThanOrEqual(1);
    const shown = asked.find((i) => ((i.confusion as Doc).lesson as Doc).number === n)
      ?.confusion as Doc;
    expect(shown).toMatchObject({
      kind: 'conflict',
      other: { lesson: `L-${other}`, sentence: 'Print letters in the house style.' },
      sides: conflictOn(other).sides,
      recommended: { resolution: 'edit', sentence: 'Print patient letters in large type.' },
    });
    const afterKeep = await lesson(n);
    expect(afterKeep.status).toBe('approved');
    expect(afterKeep.confusions[0]).toMatchObject({ resolution: 'keep', decided_by: w.stewardId });
    expect((await moves(afterKeep.id as string)).at(-1)).toEqual({
      to_status: 'approved',
      reason: 'The house style yields to large type for patients.',
      actor_id: w.stewardId,
    });
    expect(await block({ produces: ['issue'], area: 'any' })).toContain(`L-${n} `);

    // edit: the recommended sentence when the steward names none
    ok(await say('member', 'POST', at(`/lessons/${n}/confusions`), conflictOn(other)), 201);
    await pass({ settle: on(n, settled('edit', 'Narrowed to patient letters.')) });
    expect(await lesson(n)).toMatchObject({
      status: 'approved',
      sentence: 'Print patient letters in large type.',
    });
    expect(await block({ produces: ['issue'], area: 'any' })).toContain(
      'Print patient letters in large type.',
    );

    // retire: out of every prompt, with the steward's reason, the row kept
    ok(
      await say('member', 'POST', at(`/lessons/${n}/confusions`), {
        ...conflictOn(other),
        kind: 'unclear',
        other: undefined,
        recommended: { resolution: 'retire' },
      }),
      201,
    );
    await pass({ settle: on(n, settled('retire', 'Nobody can tell which letters it means.')) });
    expect(await lesson(n)).toMatchObject({
      status: 'retired',
      decided_reason: 'Nobody can tell which letters it means.',
    });
    expect(await block({ produces: ['issue'], area: 'any' })).not.toContain(
      'Print patient letters in large type.',
    );
    expect(
      codes(await say('member', 'POST', at(`/lessons/${n}/confusions`), conflictOn(other))),
    ).toEqual(['LESSON_DECIDED']);
    expect((await lesson(n)).confusions).toHaveLength(3);
  });

  it('never settles by default: with no usable answer the lesson stays held and is tried again', async () => {
    const n = await approved('Name the bed on every chart.');
    const other = await approved('Name the room on every chart.');
    ok(await say('member', 'POST', at(`/lessons/${n}/confusions`), conflictOn(other)), 201);
    const idle = await pass({});
    expect(idle.waiting).toBeGreaterThanOrEqual(1);
    expect(await lesson(n)).toMatchObject({ status: 'held' });
    expect((await lesson(n)).confusions[0]).toMatchObject({ resolution: null });
    // an edit with no sentence on a confusion that recommended none is refused, and waits too
    ok(
      await say('member', 'POST', at(`/lessons/${other}/confusions`), {
        kind: 'unclear',
        sides: { lesson: 'Rooms are named.', other: 'Some wards have no rooms.' },
        recommended: { resolution: 'keep' },
      }),
      201,
    );
    await pass({ settle: on(other, settled('edit', 'Say rooms where there are rooms.')) });
    expect((await lesson(other)).status).toBe('held');
    await pass({ settle: on(n, settled('keep', 'Beds are always named.')) });
    expect((await lesson(n)).status).toBe('approved');
  });

  it('puts no lesson in any Needs you decision or status row, whatever waits', async () => {
    const p = await proposed('Name the ward sister on every letter.');
    const n = await approved('Sign letters by the ward sister.');
    const other = await approved('Sign letters by the consultant.');
    ok(await say('member', 'POST', at(`/lessons/${n}/confusions`), conflictOn(other)), 201);
    for (const who of ['owner', 'member'] as const) {
      const read = ok(await say(who, 'GET', at('/needs-you/decisions')));
      const decisions = read.decisions as Doc[];
      expect(decisions.filter((d) => d.topic === 'lesson' || d.entity === 'lesson')).toEqual([]);
      expect(decisions.map((d) => d.key)).not.toContain(`L-${p}`);
      expect(decisions.map((d) => d.key)).not.toContain(`L-${n}`);
      const status = ok(await say(who, 'GET', at('/status')));
      const said = JSON.stringify(status);
      expect(said).not.toContain('/lessons');
      expect(said).not.toContain(`"L-${n}"`);
      expect(said).not.toContain(`"L-${p}"`);
    }
  });
});

// each case opens a project of its own, so the backlog it leaves waiting reaches no other case
describe('the steward reaches every waiting item in turn, however many keep failing (BC-2, BC-5)', () => {
  const SETTLED_PER_PASS = 10;
  const waitingCount = async (sqlText: ReturnType<typeof sql>) =>
    (await rows<{ n: number }>(sqlText))[0]?.n ?? 0;

  it('settles a good proposal behind more than a pass of proposals that never get an answer', async () => {
    const own = await ownProject();
    const failing = [];
    for (let i = 0; i < SETTLED_PER_PASS + 1; i += 1) {
      failing.push(await proposed(`Never answered, proposal ${i}.`, own.id));
    }
    const good = await proposed('Answered, behind the queue.', own.id);
    const waiting = await waitingCount(
      sql`SELECT count(*)::int AS n FROM lessons WHERE project_id = ${own.id} AND status = 'proposed'`,
    );
    expect(waiting).toBe(SETTLED_PER_PASS + 2);
    const within = Math.ceil(waiting / SETTLED_PER_PASS);
    const review = (i: Doc) => ((i.lesson as Doc).number === good ? approve() : null);
    for (let n = 0; n < within && (await lesson(good, own.id)).status === 'proposed'; n += 1) {
      await pass({ review, project: own.id });
    }
    expect((await lesson(good, own.id)).status, `settled within ${within} passes`).toBe('approved');
    for (const f of failing) expect((await lesson(f, own.id)).status).toBe('proposed');
  });

  it('settles a good confusion behind more than a pass of confusions that never get an answer', async () => {
    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    const { db } = await import('../../src/db/client.js');
    const own = await ownProject();
    const numbers = Array.from({ length: SETTLED_PER_PASS + 2 }, (_, i) => i + 1);
    for (const n of numbers) {
      await rows(sql`
        INSERT INTO lessons (project_id, number, sentence, scope_kind, proposed_by, proposed_agency)
        VALUES (${own.id}, ${n}, ${`Held lesson ${n}.`}, 'project', ${own.stewardId}, 'agent')`);
    }
    await withKernelMarker(db, (tx) =>
      tx.execute(
        sql`UPDATE lessons SET status = 'approved', approved_at = now() WHERE project_id = ${own.id} AND number IN (${sql.join(numbers, sql`, `)})`,
      ),
    );
    for (const n of numbers) {
      ok(
        await say('owner', 'POST', at(`/lessons/${n}/confusions`, own.id), {
          kind: 'unclear',
          sides: { lesson: `Lesson ${n} reads one way.`, other: 'This work reads another.' },
          recommended: { resolution: 'keep' },
        }),
        201,
      );
    }
    const good = numbers.at(-1) as number;
    const waiting = await waitingCount(
      sql`SELECT count(*)::int AS n FROM lesson_confusions WHERE project_id = ${own.id} AND decided_at IS NULL`,
    );
    expect(waiting).toBe(SETTLED_PER_PASS + 2);
    const within = Math.ceil(waiting / SETTLED_PER_PASS);
    const settle = on(good, settled('keep', 'It reads the same way here.'));
    for (let n = 0; n < within && (await lesson(good, own.id)).status === 'held'; n += 1) {
      await pass({ settle, project: own.id });
    }
    expect((await lesson(good, own.id)).status, `settled within ${within} passes`).toBe('approved');
    for (const n of numbers.slice(0, -1)) expect((await lesson(n, own.id)).status).toBe('held');
  });
});

describe('a repeat, or three corrections, becomes a check in code (BC-6)', () => {
  const checkOf = async (id: string) =>
    rows<{ id: string; title: string; status: string }>(sql`
      SELECT id, title, status FROM issues WHERE project_id = ${w.projectId} AND detector_key = ${`lesson-check/${id}`}`);

  it('files one draft check for a lesson corrected again after approval, and never again, even once dropped', async () => {
    const n = await proposed('Show the ward on the wristband.');
    await pass({ review: (i) => ((i.lesson as Doc).number === n ? approve() : null) });
    const repeat = await correction('The wristband has no ward again.');
    await pass({ links: [{ correction: repeat, lesson: n }] });
    const view = await lesson(n);
    expect(view.corrections).toHaveLength(2);
    expect(view.check_issue_id).not.toBeNull();
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
    await pass({
      proposals: [proposal('Name the bed in every handover.', three)],
      review: (i) =>
        (i.lesson as Doc).sentence === 'Name the bed in every handover.' ? approve() : null,
    });
    const n = await numberOf('Name the bed in every handover.');
    expect((await lesson(n)).check_issue_id).not.toBeNull();
    expect((await lesson(two)).check_issue_id).toBeNull();
  });
});

describe('the steward retires an unused or superseded lesson with a reason, never deleting it (BC-7)', () => {
  it('retires one unused for 30 days, and keeps one applied since', async () => {
    const n = await approved('Greet the patient by name.');
    const used = await approved('Greet the visitor by name.');
    await rows(
      sql`UPDATE lessons SET approved_at = now() - interval '31 days' WHERE project_id = ${w.projectId} AND number IN (${n}, ${used})`,
    );
    ok(
      await say('member', 'POST', at('/lessons/applied'), {
        lessons: [used],
        output: { kind: 'job', ref: 'job-greet' },
      }),
    );
    expect((await pass({})).retired).toBeGreaterThanOrEqual(1);
    const gone = await lesson(n);
    expect(gone).toMatchObject({
      status: 'retired',
      decided_reason: 'No agent applied it in 30 days.',
    });
    expect((await moves(gone.id as string)).at(-1)).toMatchObject({
      to_status: 'retired',
      actor_id: w.stewardId,
    });
    expect((await lesson(used)).status).toBe('approved');
    expect(await block({ produces: ['issue'], area: 'any' })).not.toContain(`L-${n} `);
  });

  it('retires a superseded one when its replacement is approved; the row stays', async () => {
    const old = await approved('Letters go out by post.');
    const a = await correction('Send letters by email (1).');
    const b = await correction('Send letters by email (2).');
    await pass({
      proposals: [proposal('Letters go out by email.', [a, b], undefined, old)],
      review: (i) => ((i.lesson as Doc).sentence === 'Letters go out by email.' ? approve() : null),
    });
    const made = await numberOf('Letters go out by email.');
    expect(await lesson(made)).toMatchObject({ status: 'approved' });
    expect(await lesson(old)).toMatchObject({
      status: 'retired',
      superseded_by: made,
      decided_reason: `Superseded by L-${made}.`,
    });
  });
});

describe('the monthly figures core keeps (BC-8)', () => {
  it('counts the month: corrections by source, approvals, repeats and confusions with time to settlement', async () => {
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
    const { lessonsMonth } = await import('../../src/lessons/index.js');
    const read = await lessonsMonth({ projectId: other, month: '2026-09' });
    expect(read).toMatchObject({
      month: '2026-09',
      corrections: { total: 3, bySource: { suggestion_rejected: 2, verdict_failed: 1, chat: 0 } },
      lessonsApproved: 1,
      repeats: 1,
      confusions: { raised: 2, settled: 1, open: 1 },
    });
    expect(read.confusions.items.find((i) => i.kind === 'unclear')?.hours).toBe(6);
  });
});
