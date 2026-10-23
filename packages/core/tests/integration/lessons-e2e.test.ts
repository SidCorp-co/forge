// REQ-50 r2 BC-2..BC-4, BC-9: the steward groups corrections into a proposed lesson, then checks it
// and approves, edits or rejects it with a reason, and no person is asked; an approved lesson reaches
// every agent in its scope through project knowledge and nothing unapproved does; and an output lists
// the lessons it applied, an agent able to mark one wrongly applied. Through the app's own routes
// against real Postgres; the steward's model answers are the test's own (`../helpers/lessons-world.ts`).
// BC-5..BC-8: lessons-held-e2e.
//
// @direct-test-of packages/core/src/lessons/decide.ts
// @direct-test-of packages/core/src/lessons/applied.ts
// @direct-test-of packages/core/src/lessons/block.ts
// @direct-test-of packages/core/src/lessons/routes.ts
// @direct-test-of packages/core/src/knowledge/lesson-entries.ts
// @direct-test-of packages/core/src/steward/lessons-pass.ts
// @direct-test-of packages/core/src/steward/lessons-review.ts
// @direct-test-of packages/core/src/steward/lessons-scope.ts

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { type Doc, ok } from '../helpers/ecosystem-world.js';
import { rows } from '../helpers/factories.js';
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
  pass,
  proposal,
  proposed,
  say,
  w,
} from '../helpers/lessons-world.js';

openLessonsWorld();

describe('the steward proposes a lesson and settles it, and no person is asked (BC-2)', () => {
  it('groups two similar corrections into one proposal as the steward, and leaves a lone one waiting', async () => {
    const a = await correction('Breakdowns slice by table.');
    const b = await correction('Again sliced by table, slice by screen.');
    const lone = await correction('The logo is too small.');
    const tally = await pass({
      proposals: [
        proposal('Slice a breakdown by screen, never by table.', [a, b]),
        proposal('Make the logo bigger.', [lone]),
      ],
    });
    // nothing answered its review, so it waits: proposed, applied by no agent, and asked of nobody
    expect(tally).toMatchObject({ proposed: 1, approved: 0, rejected: 0 });
    const made = await lesson(await numberOf('Slice a breakdown by screen, never by table.'));
    expect(made).toMatchObject({
      status: 'proposed',
      proposed_by: w.stewardId,
      scope_kind: 'project',
    });
    expect(made.corrections.map((c) => c.id).sort()).toEqual([a, b].sort());
    const [left] = await rows<{ lesson_id: string | null }>(
      sql`SELECT lesson_id FROM corrections WHERE id = ${lone}`,
    );
    expect(left?.lesson_id).toBeNull();
  });

  it('approves, edits then approves, or rejects a proposal as the steward, each with a reason the kernel keeps', async () => {
    const a = await correction('Dates read as US.');
    const b = await correction('Use day-month dates.');
    const c = await correction('Too many emojis.');
    const d = await correction('No emojis please.');
    const e = await correction('Name the ward (1).');
    const f = await correction('Name the ward (2).');
    const seen: Doc[] = [];
    const tally = await pass({
      proposals: [
        proposal('Write dates as day month.', [a, b]),
        proposal('Never use emojis.', [c, d]),
        proposal('Name the ward.', [e, f]),
      ],
      review: (input) => {
        seen.push(input);
        const said = (input.lesson as Doc).sentence as string;
        if (said === 'Write dates as day month.') {
          return {
            ...approve('The corrections asked for day-month dates; scoped to requirements.'),
            verdict: 'edit',
            sentence: 'Write every date as day month year.',
            scope: 'item_kind',
            itemKind: 'requirement',
          };
        }
        if (said === 'Never use emojis.') {
          return { ...approve('Emojis are fine in chat.'), verdict: 'reject' };
        }
        return said === 'Name the ward.'
          ? approve('Both corrections ask for the ward by name.')
          : null;
      },
    });
    expect(tally).toMatchObject({ proposed: 3, approved: 2, rejected: 1 });
    // the steward reviewed each against its corrections and the requirements and designs in scope
    for (const said of ['Write dates as day month.', 'Never use emojis.', 'Name the ward.']) {
      const shown = seen.find((i) => (i.lesson as Doc).sentence === said);
      if (!shown) throw new Error(`the steward reviewed no "${said}"`);
      expect(((shown.lesson as Doc).corrections as Doc[]).map((c) => c.reason)).toHaveLength(2);
      expect(String(shown.scope)).toContain('Requirements in its scope');
    }

    const dates = await lesson(await numberOf('Write every date as day month year.'));
    expect(dates).toMatchObject({ status: 'approved', scope_item_kind: 'requirement' });
    expect(await moves(dates.id as string)).toEqual([
      {
        to_status: 'approved',
        reason: 'The corrections asked for day-month dates; scoped to requirements.',
        actor_id: w.stewardId,
      },
    ]);
    const emojis = await lesson(await numberOf('Never use emojis.'));
    expect(emojis).toMatchObject({
      status: 'rejected',
      decided_reason: 'Emojis are fine in chat.',
    });
    expect((await moves(emojis.id as string))[0]).toMatchObject({
      to_status: 'rejected',
      actor_id: w.stewardId,
    });
    expect((await lesson(await numberOf('Name the ward.'))).status).toBe('approved');
  });

  it('never approves by default: no usable answer, or a refused edit, leaves it proposed for the next pass', async () => {
    const n = await proposed('Close the ward list at noon.');
    const only = (answer: Doc) => (input: Doc) =>
      (input.lesson as Doc).number === n ? answer : null;
    const before = await pass({});
    expect(before).toMatchObject({ approved: 0, rejected: 0 });
    expect(before.waiting).toBeGreaterThanOrEqual(1);
    expect((await lesson(n)).status).toBe('proposed');

    // an edit that names no change, or an area that is not this project's, is no decision
    const unnamed = { ...approve('Narrow it.'), verdict: 'edit' };
    expect(await pass({ review: only(unnamed) })).toMatchObject({ approved: 0 });
    const elsewhere = { ...unnamed, scope: 'area', areaId: randomUUID() };
    expect(await pass({ review: only(elsewhere) })).toMatchObject({ approved: 0 });
    expect((await lesson(n)).status).toBe('proposed');
    expect(await moves((await lesson(n)).id as string)).toEqual([]);

    expect(await pass({ review: only(approve()) })).toMatchObject({ approved: 1 });
    expect((await lesson(n)).status).toBe('approved');
  });

  it('serves no person a lesson: every route a screen read or decided one by is gone', async () => {
    const n = await approved('Keep handovers under a page.');
    const gone: [string, string, unknown?][] = [
      ['GET', at('/lessons')],
      ['GET', at(`/lessons/${n}`)],
      ['GET', at('/lessons/month')],
      ['POST', at('/lessons'), {}],
      ['PATCH', at(`/lessons/${n}`), {}],
      ['POST', at(`/lessons/${n}/approve`), {}],
      ['POST', at(`/lessons/${n}/reject`), { reason: 'x' }],
      ['POST', at(`/lessons/${n}/retire`), { reason: 'x' }],
      ['POST', at(`/lessons/${n}/keep`), {}],
      ['POST', at(`/lessons/confusions/${randomUUID()}/decide`), { resolution: 'keep' }],
      ['POST', at(`/lessons/corrections/${randomUUID()}/dismiss`), {}],
      ['POST', at(`/lessons/applications/${randomUUID()}/wrong`), { reason: 'x' }],
      ['GET', at(`/lessons/chat/${randomUUID()}`)],
    ];
    for (const [method, path, body] of gone) {
      expect((await say('owner', method, path, body)).status, `${method} ${path}`).toBe(404);
    }
  });
});

describe('an approved lesson reaches every agent in its scope, and nothing else does (BC-3)', () => {
  it('reaches the run preamble, the checkout orientation, the assistant and the steward; a proposal reaches none', async () => {
    const n = await approved('Name the ward on every reminder.');
    const a = await correction('Use plain words (1).');
    const b = await correction('Use plain words (2).');
    await pass({ proposals: [proposal('Use plain words, never codes.', [a, b])] });
    const { loadProjectFactInputs, renderStageFactsText } = await import(
      '../../src/prompt/facts/resolve.js'
    );
    const { servedCheckoutOrientation } = await import('../../src/prompt/checkout-orientation.js');
    const preamble = renderStageFactsText(
      await loadProjectFactInputs(w.projectId),
      w.projectId,
      'plan',
    );
    const orientation = await servedCheckoutOrientation(w.projectId, 'lessons');
    const assistant = await block({ produces: ['chat', 'requirement'], area: 'any' });
    for (const text of [preamble, orientation, assistant]) {
      expect(text).toContain(`L-${n} [all work]: Name the ward on every reminder.`);
      expect(text).toContain('Lessons applied: L-3, L-7');
      expect(text).toContain('until the steward settles it');
      expect(text).not.toContain('Use plain words, never codes.');
      expect(text).not.toMatch(/by a person|a person decides/);
    }
    expect(preamble).not.toMatch(/Project rules[\s\S]*lesson-/);
  });

  it('scopes by area and by kind of item', async () => {
    const billing = await approved('Show totals with tax.', {
      scope: 'area',
      areaId: w.areaA,
      itemKind: null,
    });
    const reqs = await approved('Every criterion names its actor.', {
      scope: 'item_kind',
      areaId: null,
      itemKind: 'requirement',
    });
    expect(await block({ produces: ['issue'], area: w.areaA })).toContain(`L-${billing}`);
    expect(await block({ produces: ['issue'], area: w.areaB })).not.toContain(`L-${billing}`);
    expect(await block({ produces: ['issue'], area: null })).not.toContain(`L-${reqs} `);
    expect(await block({ produces: ['requirement'], area: null })).toContain(
      `L-${reqs} [requirements]`,
    );
    expect(await block({ produces: ['issue'], area: 'any' })).toContain(
      `L-${billing} [only work in the area Billing]`,
    );
  });

  it('the knowledge door refuses a write to a lesson entry by name', async () => {
    const n = await approved('Keep ward names short.');
    const put = await say('owner', 'PUT', at(`/knowledge/lesson-${n}`), {
      title: 'x',
      body: 'rewritten',
      kind: 'rule',
      injection: 'always',
    });
    expect(codes(put)).toEqual(['KNOWLEDGE_LESSON_OWNED']);
    const named = await say('owner', 'PUT', at('/knowledge/my-own'), {
      title: 'x',
      body: 'y',
      kind: 'lesson',
      injection: 'always',
    });
    expect(codes(named)).toEqual(['KNOWLEDGE_LESSON_OWNED']);
    expect(codes(await say('owner', 'DELETE', at(`/knowledge/lesson-${n}`)))).toEqual([
      'KNOWLEDGE_LESSON_OWNED',
    ]);
  });
});

describe('an output lists the lessons it applied, and an agent marks one wrongly applied (BC-4)', () => {
  it('records approved lessons per output once, and refuses one that is not approved by name', async () => {
    const n = await approved('Sort wards by floor.');
    const body = { lessons: [n], output: { kind: 'job', ref: 'job-sort-1' } };
    expect(ok(await say('member', 'POST', at('/lessons/applied'), body))).toEqual({ recorded: 1 });
    expect(ok(await say('member', 'POST', at('/lessons/applied'), body))).toEqual({ recorded: 0 });
    expect((await say('viewer', 'POST', at('/lessons/applied'), body)).status).toBe(403);
    const refused = await say('member', 'POST', at('/lessons/applied'), {
      lessons: [n, 999],
      output: { kind: 'job', ref: 'x' },
    });
    expect(codes(refused)).toEqual(['LESSON_NOT_APPLICABLE']);
    expect(refused.json.detail).toContain('L-999');
    const { recordAppliedFromText } = await import('../../src/lessons/index.js');
    const fromText = await recordAppliedFromText({
      projectId: w.projectId,
      text: `Done.\n\nLessons applied: L-${n}, L-999`,
      output: { kind: 'chat_message', ref: randomUUID() },
      agentUserId: null,
    });
    expect(fromText).toBe(1);
    const view = await lesson(n);
    expect(view.applied_count).toBe(2);
    expect(view.applications.map((a) => a.output_kind).sort()).toEqual(['chat_message', 'job']);

    // a lesson that is not approved is never applied, by the door or by a line in a model's text
    const p = await proposed('Sort wards by wing.');
    const notYet = await say('member', 'POST', at('/lessons/applied'), {
      lessons: [p],
      output: { kind: 'job', ref: 'job-sort-2' },
    });
    expect(codes(notYet)).toEqual(['LESSON_NOT_APPLICABLE']);
    expect(notYet.json.detail).toContain(`L-${p}`);
    const fromProposal = await recordAppliedFromText({
      projectId: w.projectId,
      text: `Lessons applied: L-${p}`,
      output: { kind: 'chat_message', ref: randomUUID() },
      agentUserId: null,
    });
    expect(fromProposal).toBe(0);
    expect(await lesson(p)).toMatchObject({ applied_count: 0, applications: [] });
  });

  it('an agent marks one wrongly applied from its output: a confusion that holds the lesson for the steward', async () => {
    const n = await approved('Close a ward at midnight.');
    ok(
      await say('member', 'POST', at('/lessons/applied'), {
        lessons: [n],
        output: { kind: 'issue', ref: 'ISS-7' },
      }),
    );
    const wrong = (ref: string) => ({
      kind: 'wrongly_applied',
      other: { ref },
      sides: { lesson: 'Wards close at midnight.', other: 'ISS-7 is about day wards.' },
      recommended: { resolution: 'edit', sentence: 'Close a night ward at midnight.' },
    });
    expect(
      codes(await say('member', 'POST', at(`/lessons/${n}/confusions`), wrong('ISS-8'))),
    ).toEqual(['LESSON_CONFUSION_INVALID']);
    const raised = ok(
      await say('member', 'POST', at(`/lessons/${n}/confusions`), wrong('ISS-7')),
      201,
    );
    expect(raised).toEqual({ lesson: { key: `L-${n}`, status: 'held' } });
    const held = await lesson(n);
    expect(held.status).toBe('held');
    expect(held.applications[0]).toMatchObject({ wrong_reason: 'ISS-7 is about day wards.' });
    expect(held.confusions).toEqual([
      expect.objectContaining({
        kind: 'wrongly_applied',
        resolution: null,
        application_id: held.applications[0]?.id,
      }),
    ]);
    expect(
      codes(await say('member', 'POST', at(`/lessons/${n}/confusions`), wrong('ISS-7'))),
    ).toEqual(['LESSON_APPLICATION_MARKED']);
  });
});
