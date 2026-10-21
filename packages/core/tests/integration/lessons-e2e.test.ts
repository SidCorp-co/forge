// REQ-50 BC-2..BC-8: the steward groups corrections into a proposed lesson that a person approves,
// edits or rejects; an approved lesson reaches every agent in its scope through project knowledge and
// nothing unapproved does; an output lists the lessons it applied and a person can mark one wrongly
// applied; a confusion holds the lesson until a person decides; a repeat becomes a check; an unused
// or superseded lesson is proposed for retirement; and the monthly read counts all of it. Through the
// app's own routes against real Postgres; the steward's grouping is the test's own answer.
//
// @direct-test-of packages/core/src/lessons/decide.ts
// @direct-test-of packages/core/src/lessons/confusions.ts
// @direct-test-of packages/core/src/lessons/applied.ts
// @direct-test-of packages/core/src/lessons/gather.ts
// @direct-test-of packages/core/src/lessons/month.ts
// @direct-test-of packages/core/src/lessons/block.ts
// @direct-test-of packages/core/src/knowledge/lesson-entries.ts
// @direct-test-of packages/core/src/steward/lessons-pass.ts

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  seedIssueStatus,
} from '../helpers/factories.js';

type Who = 'owner' | 'member' | 'viewer';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let stewardId = '';
let areaA = '';
let areaB = '';
const at = (path: string, project = projectId) => `/api/projects/${project}${path}`;
const codes = (r: Reply) => (r.json.error?.refusals ?? []).map((x: Doc) => x.code);

type Pass = typeof import('../../src/steward/lessons-pass.js');
let runLessonsPass: Pass['runLessonsPass'];

async function correction(
  reason: string,
  over: { areaId?: string | null; at?: Date; project?: string; source?: string } = {},
) {
  const { db } = await import('../../src/db/client.js');
  const { recordCorrection } = await import('../../src/lessons/index.js');
  const id = await db.transaction((tx) =>
    recordCorrection(tx, {
      projectId: over.project ?? projectId,
      source: (over.source ?? 'suggestion_rejected') as 'suggestion_rejected',
      sourceRef: randomUUID(),
      item: { kind: 'suggestion', id: randomUUID(), key: 'REQ-1' },
      areaId: over.areaId ?? null,
      reason,
      by: { userId: ownerId, agency: 'human' },
      ...(over.at ? { at: over.at } : {}),
    }),
  );
  if (!id) throw new Error('the correction was not kept');
  return id;
}

/** The steward's pass with the test's own grouping: link and propose exactly what is asked. */
async function pass(answer: {
  links?: { correction: string; lesson: number }[];
  proposals?: Doc[];
}) {
  const tally = await runLessonsPass({
    projectIds: [projectId],
    group: async () => ({
      links: answer.links ?? [],
      proposals: (answer.proposals ?? []) as never,
    }),
  });
  expect(tally.failed, 'a lessons pass failed on the project').toBe(0);
  return tally;
}

const lesson = async (n: number) =>
  ok(await say('owner', 'GET', at(`/lessons/${n}`))).lesson as Doc;
const proposal = (
  sentence: string,
  corrections: string[],
  scope: Doc = { scope: 'project', areaId: null, itemKind: null },
) => ({
  sentence,
  corrections,
  ...scope,
});

/** An approved lesson, proposed by the steward from two corrections. */
async function approved(sentence: string, scope?: Doc): Promise<number> {
  const a = await correction(`${sentence} (1)`);
  const b = await correction(`${sentence} (2)`);
  await pass({ proposals: [proposal(sentence, [a, b], scope)] });
  const list = ok(await say('owner', 'GET', at('/lessons'))).lessons as Doc[];
  const n = list.find((l) => l.sentence === sentence)?.number as number;
  ok(await say('owner', 'POST', at(`/lessons/${n}/approve`), {}));
  return n;
}

/** A lesson a member proposed by hand from one correction: never approved, so never applied. */
async function proposed(sentence: string): Promise<Doc> {
  const one = await correction(`${sentence} (said once)`);
  const body = { sentence, scope: { kind: 'project' }, corrections: [one] };
  return ok(await say('member', 'POST', at('/lessons'), body), 201).lesson as Doc;
}

async function block(audience: { produces: string[]; area: string | null | 'any' }) {
  const { lessonsBlockFor } = await import('../../src/lessons/index.js');
  return (await lessonsBlockFor(projectId, { ...audience, raise: 'test' } as never, 2)) ?? '';
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  ({ runLessonsPass } = await import('../../src/steward/lessons-pass.js'));
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  const memberId = (await createTestUser({ verified: true })).id;
  const viewerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, memberId, 'member');
  await addProjectMember(projectId, viewerId, 'viewer');
  const { stewardAccountOf } = await import('../../src/steward/account.js');
  stewardId = await stewardAccountOf(projectId);
  [areaA, areaB] = (
    await rows<{ id: string }>(sql`
      INSERT INTO requirement_areas (project_id, name) VALUES (${projectId}, 'Billing'), (${projectId}, 'Wards')
      RETURNING id`)
  ).map((r) => r.id) as [string, string];
  say = requester(app, {
    owner: await signUserToken(ownerId),
    member: await signUserToken(memberId),
    viewer: await signUserToken(viewerId),
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

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
      proposedBy: { id: stewardId },
      scope: { kind: 'project' },
    });
    expect((made?.corrections as Doc[]).map((c) => c.id).sort()).toEqual([a, b].sort());
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
      await loadProjectFactInputs(projectId),
      projectId,
      'plan',
    );
    const orientation = await servedCheckoutOrientation(projectId, 'lessons');
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
      areaId: areaA,
      itemKind: null,
    });
    const reqs = await approved('Every criterion names its actor.', {
      scope: 'item_kind',
      areaId: null,
      itemKind: 'requirement',
    });
    expect(await block({ produces: ['issue'], area: areaA })).toContain(`L-${billing}`);
    expect(await block({ produces: ['issue'], area: areaB })).not.toContain(`L-${billing}`);
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
      projectId,
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
      projectId,
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

describe('on confusion the agent stops, and the lesson is held until a person decides (BC-5)', () => {
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
      SELECT id, title, status FROM issues WHERE project_id = ${projectId} AND detector_key = ${`lesson-check/${id}`}`);

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
      sql`UPDATE lessons SET approved_at = now() - interval '31 days' WHERE project_id = ${projectId} AND number = ${n}`,
    );
    await pass({});
    expect((await lesson(n)).retire).toMatchObject({ reason: 'unused' });
    const kept = ok(await say('owner', 'POST', at(`/lessons/${n}/keep`), {})).lesson as Doc;
    expect(kept.retire).toBeNull();
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
    const other = (await createTestProject(ownerId)).id;
    const sep = (d: number, h = 9) => new Date(Date.UTC(2026, 8, d, h));
    await correction('a', { project: other, at: sep(2) });
    await correction('b', { project: other, at: sep(3) });
    await correction('c', { project: other, at: sep(4), source: 'verdict_failed' });
    await correction('out of month', { project: other, at: new Date(Date.UTC(2026, 9, 1)) });
    const [l] = await rows<{ id: string }>(sql`
      INSERT INTO lessons (project_id, number, sentence, scope_kind, status, proposed_by, proposed_agency, approved_at)
      VALUES (${other}, 1, 'One lesson.', 'project', 'proposed', ${ownerId}, 'human', NULL) RETURNING id`);
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
