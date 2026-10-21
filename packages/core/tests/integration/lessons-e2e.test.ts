// REQ-50 BC-2..BC-4: the steward groups corrections into a proposed lesson that a person approves,
// edits or rejects; an approved lesson reaches every agent in its scope through project knowledge and
// nothing unapproved does; and an output lists the lessons it applied, a person able to mark one
// wrongly applied. Through the app's own routes against real Postgres; the steward's grouping is the
// test's own answer (`../helpers/lessons-world.ts`). BC-5..BC-8: lessons-held-e2e.
//
// @direct-test-of packages/core/src/lessons/decide.ts
// @direct-test-of packages/core/src/lessons/applied.ts
// @direct-test-of packages/core/src/lessons/block.ts
// @direct-test-of packages/core/src/knowledge/lesson-entries.ts
// @direct-test-of packages/core/src/steward/lessons-pass.ts

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type Doc, ok } from '../helpers/ecosystem-world.js';
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

describe('the steward proposes a lesson, and a person decides it (BC-2)', () => {
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
    expect(tally.proposed).toBe(1);
    const read = ok(await say('owner', 'GET', at('/lessons')));
    const made = (read.lessons as Doc[]).find((l) => l.sentence.startsWith('Slice a breakdown'));
    expect(made).toMatchObject({
      status: 'proposed',
      proposedBy: { id: w.stewardId },
      scope: { kind: 'project' },
    });
    expect(((made as Doc).corrections as Doc[]).map((c) => c.id).sort()).toEqual([a, b].sort());
    expect((read.corrections as Doc[]).map((c) => c.id)).toContain(lone);
  });

  it('a person edits, then approves; approval needs suggestions.approve and a rejection says why', async () => {
    const a = await correction('Dates read as US.');
    const b = await correction('Use day-month dates.');
    await pass({ proposals: [proposal('Write dates as day month.', [a, b])] });
    const n = (ok(await say('owner', 'GET', at('/lessons'))).lessons as Doc[]).find(
      (l) => l.sentence === 'Write dates as day month.',
    )?.number as number;
    const refused = await say('member', 'POST', at(`/lessons/${n}/approve`), {});
    expect(refused.status).toBe(403);
    ok(
      await say('owner', 'PATCH', at(`/lessons/${n}`), {
        sentence: 'Write every date as day month year.',
      }),
    );
    const done = ok(
      await say('owner', 'POST', at(`/lessons/${n}/approve`), {
        scope: { kind: 'item_kind', itemKind: 'requirement' },
      }),
    ).lesson as Doc;
    expect(done).toMatchObject({
      status: 'approved',
      sentence: 'Write every date as day month year.',
      scope: { kind: 'item_kind', itemKind: 'requirement' },
    });
    const again = await say('owner', 'POST', at(`/lessons/${n}/approve`), {});
    expect(codes(again)).toEqual(['LESSON_DECIDED']);

    const c = await correction('Too many emojis.');
    const d = await correction('No emojis please.');
    await pass({ proposals: [proposal('Never use emojis.', [c, d])] });
    const m = (ok(await say('owner', 'GET', at('/lessons'))).lessons as Doc[]).find(
      (l) => l.sentence === 'Never use emojis.',
    )?.number as number;
    expect((await say('owner', 'POST', at(`/lessons/${m}/reject`), {})).status).toBe(400);
    const rejected = ok(
      await say('owner', 'POST', at(`/lessons/${m}/reject`), {
        reason: 'Emojis are fine in chat.',
      }),
    ).lesson as Doc;
    expect(rejected).toMatchObject({ status: 'rejected', reason: 'Emojis are fine in chat.' });
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
      expect(text).not.toContain('Use plain words, never codes.');
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

describe('an output lists the lessons it applied, and a person can mark one wrong (BC-4)', () => {
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
    expect(view.appliedCount).toBe(2);
    expect((view.applications as Doc[]).map((a) => a.output.kind).sort()).toEqual([
      'chat_message',
      'job',
    ]);

    // a lesson that is not approved is never applied, by the door or by a line in a model's text
    const p = (await proposed('Sort wards by wing.')).number as number;
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
    expect(await lesson(p)).toMatchObject({ appliedCount: 0, applications: [] });
  });

  it('marking one wrongly applied raises a confusion and holds the lesson', async () => {
    const n = await approved('Close a ward at midnight.');
    ok(
      await say('member', 'POST', at('/lessons/applied'), {
        lessons: [n],
        output: { kind: 'issue', ref: 'ISS-7' },
      }),
    );
    const app = ((await lesson(n)).applications as Doc[])[0]?.id as string;
    const marked = ok(
      await say('member', 'POST', at(`/lessons/applications/${app}/wrong`), {
        reason: 'ISS-7 is about day wards.',
      }),
    ).lesson as Doc;
    expect(marked.status).toBe('held');
    expect(marked.confusions).toEqual([
      expect.objectContaining({ kind: 'wrongly_applied', resolution: null }),
    ]);
    expect((marked.applications as Doc[])[0]?.wrong).toMatchObject({
      reason: 'ISS-7 is about day wards.',
    });
    expect(
      codes(
        await say('member', 'POST', at(`/lessons/applications/${app}/wrong`), { reason: 'again' }),
      ),
    ).toEqual(['LESSON_APPLICATION_MARKED']);
  });
});
