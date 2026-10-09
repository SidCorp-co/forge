/**
 * REQ-41 BC-12 and BC-1 (docs/proposals/chat-first.md, "Noise cut at the source"): a draft nobody
 * touched for a week gets one merge-or-drop question, the needs-me read files it under
 * `merge_or_drop`, and the answer acts by itself. Drop drops the draft naming the question; keep
 * changes nothing; merge moves the draft into the target its option names (a proposed revision of a
 * requirement, a comment on an issue) and drops it naming the target. A merge a rule says cannot be
 * done safely is refused by name on the answered round and the draft waits on the master. Driven
 * through the real app and outbox worker on a throwaway Postgres.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';

const DAY = 86_400_000;
let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
const at = (path: string) => `/api/projects/${projectId}${path}`;
const as = (method: string, path: string, body?: unknown) => say('owner', method, at(path), body);

const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/** A draft requirement at r1, its every touch backdated `days`. */
async function staleRequirement(
  title: string,
  days: number,
  spec: Doc = {},
  criteria = [{ body: `${title} works end to end.` }],
): Promise<string> {
  const key = ok(
    await as('POST', '/requirements', { title, reason: 'asked once', spec, criteria }),
    201,
  ).key as string;
  const seq = Number(key.slice(4));
  await db.execute(sql`
    UPDATE requirement_revisions SET created_at = ${daysAgo(days)}
     WHERE requirement_id = (SELECT id FROM requirements WHERE project_id = ${projectId} AND req_seq = ${seq})`);
  await db.execute(sql`
    UPDATE requirements SET updated_at = ${daysAgo(days)} WHERE project_id = ${projectId} AND req_seq = ${seq}`);
  return key;
}

/** A requirement agreed at r1. */
async function agreedRequirement(title: string, spec: Doc, criteria: Doc[]): Promise<string> {
  const key = ok(
    await as('POST', '/requirements', { title, reason: 'agreed', spec, criteria }),
    201,
  ).key as string;
  ok(await as('POST', `/requirements/${key}/revisions/1/propose`, {}));
  ok(await as('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'ok' }));
  ok(await as('POST', `/requirements/${key}/agree`, { revision: 1, reason: 'ok' }));
  return key;
}

/** An issue at `status`, titled, untouched for `days`. */
async function issueAt(seq: number, title: string, status: string, days: number) {
  const issue = await createTestIssue(projectId, ownerId, seq, {
    status: status as never,
    createdAt: new Date(Date.now() - days * DAY),
  });
  await db.execute(sql`
    UPDATE issues SET title = ${title}, description = ${`What ${title} means, in the reporter's words.`},
                      updated_at = ${daysAgo(days)}
     WHERE id = ${issue.id}`);
  return issue;
}

const reqId = async (key: string) =>
  (
    await rows<{ id: string }>(
      sql`SELECT id FROM requirements WHERE project_id = ${projectId} AND req_seq = ${Number(key.slice(4))}`,
    )
  )[0]?.id ?? '';

/** The newest question on a requirement or issue, with its last round. */
async function questionOn(on: { requirement?: string; issueId?: string }) {
  const where = on.issueId
    ? sql`q.issue_id = ${on.issueId}`
    : sql`q.requirement_id = ${await reqId(on.requirement ?? '')}`;
  const [q] = await rows<{ id: string; status: string; last: Doc }>(sql`
    SELECT q.id, q.status, q.steps -> -1 AS last FROM agent_questions q
     WHERE ${where} ORDER BY q.created_at DESC LIMIT 1`);
  if (!q) throw new Error(`no question on ${JSON.stringify(on)}`);
  return q;
}

async function answer(questionId: string, optionId: string) {
  ok(await say('owner', 'POST', `/api/questions/${questionId}/answer`, { round: 1, optionId }));
  await settleOutbox();
}

const decisions = async () => ok(await as('GET', '/needs-you/decisions')) as Doc;
const decisionOf = async (key: string) =>
  ((await decisions()).decisions as Doc[]).find((d) => d.key === key);
const needsYouKeys = async (): Promise<string[]> =>
  ((ok(await as('GET', '/needs-you')).items as Doc[]) ?? []).map((r) => String(r.key));
const issueStanding = async (key: string) => {
  const read = ok(await as('GET', `/issues/standing/${key}`)) as Doc;
  return ((read.standing ?? read) as Doc).waitingOn as Doc;
};
const requirementStanding = async (key: string) =>
  (ok(await as('GET', `/requirements/${key}`)).standing as Doc).waitingOn as Doc;

const lastMove = async (entity: 'issue' | 'requirement', id: string) =>
  (
    await rows<{ to_status: string; reason: string | null }>(sql`
      SELECT to_status, reason FROM kernel_transitions
       WHERE entity = ${entity} AND entity_id = ${id} ORDER BY created_at DESC LIMIT 1`)
  )[0];

const drafts = {
  dropReq: '',
  mergeReq: '',
  refusedReq: '',
  target: '',
  dropIssue: { id: '', key: '' },
  mergeIssue: { id: '', key: '' },
  twin: { id: '', key: '' },
  keepIssue: { id: '', key: '' },
  refusedIssue: { id: '', key: '' },
  goneTwin: { id: '', key: '' },
};

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  // a runner is online, so the master these waits name can act (FB-77)
  await bindTestRunner(projectId, await createTestDevice(ownerId));
  say = requester(app, { owner: await signUserToken(ownerId) });

  drafts.target = await agreedRequirement(
    'Call list export',
    { scopeIn: ['Export the call list'] },
    [{ body: 'The call list exports to a spreadsheet.' }],
  );
  drafts.dropReq = await staleRequirement('Fax the call list', 8);
  drafts.mergeReq = await staleRequirement(
    'Export the call list as CSV',
    9,
    { scopeIn: ['Export the call list', 'CSV with a header row'], personas: ['Coordinator'] },
    [{ body: 'The call list exports to a spreadsheet.' }, { body: 'The CSV opens in Excel.' }],
  );
  drafts.refusedReq = await staleRequirement('Export the call list as XLSX', 10, {}, [
    { body: 'The export is an XLSX file.' },
  ]);
  drafts.dropIssue = await issueAt(701, 'Old spike nobody wanted', 'draft', 9);
  drafts.mergeIssue = await issueAt(702, 'Export calls from the list', 'draft', 9);
  drafts.twin = await issueAt(703, 'Export calls from the list', 'open', 1);
  drafts.keepIssue = await issueAt(704, 'Maybe later: dark mode', 'draft', 9);
  drafts.refusedIssue = await issueAt(705, 'Archive old calls', 'draft', 9);
  drafts.goneTwin = await issueAt(706, 'Archive old calls', 'open', 1);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('BC-1, BC-12: a stale draft is asked once, filed under merge_or_drop with Forge’s recommended answer', () => {
  it('asks each stale draft, merge named on its option where a live twin exists', async () => {
    const { sweepStaleDrafts } = await import('../../src/requirements/stale-drafts.js');
    expect((await sweepStaleDrafts()).refused).toBe(0);

    const merge = await questionOn({ issueId: drafts.mergeIssue.id });
    const options = merge.last.options as Doc[];
    expect(options.map((o) => o.id)).toEqual([
      'stale_draft.merge',
      'stale_draft.drop',
      'stale_draft.keep',
    ]);
    expect(options[0]?.target).toEqual({ kind: 'issue', id: drafts.twin.id, key: drafts.twin.key });
    expect(merge.last.recommendedOptionId).toBe('stale_draft.merge');
    const drop = await questionOn({ issueId: drafts.dropIssue.id });
    expect(
      (drop.last.options as Doc[]).map((o) => o.id),
      'no twin, no merge offered',
    ).toEqual(['stale_draft.drop', 'stale_draft.keep']);

    // the requirement merge's target is found by vector in the sweep; this test has no embedder, so
    // the merge question for it is the sweep's own builder with the target named, asked as it asks
    const { staleDraftQuestion } = await import('../../src/requirements/stale-drafts.js');
    const { askQuestion } = await import('../../src/questions/index.js');
    for (const key of [drafts.mergeReq, drafts.refusedReq]) {
      await db.execute(sql`DELETE FROM agent_questions WHERE requirement_id = ${await reqId(key)}`);
      const q = staleDraftQuestion(
        { key, title: key, what: 'a draft requirement' },
        {
          key,
          mergeInto: { kind: 'requirement', id: await reqId(drafts.target), key: drafts.target },
          asks: [],
          ended: null,
          days: 9,
        },
      );
      await askQuestion({
        id: crypto.randomUUID(),
        projectId,
        requirementId: await reqId(key),
        prompt: q.prompt,
        blockerKind: 'human',
        answer: { shape: 'choice', options: q.options, recommendedOptionId: q.recommendedOptionId },
      });
    }
  });

  it('files every one of them under merge_or_drop, recommended by rule, each button saying what it does', async () => {
    const read = await decisions();
    const keys = [
      drafts.dropReq,
      drafts.mergeReq,
      drafts.refusedReq,
      drafts.dropIssue.key,
      drafts.mergeIssue.key,
      drafts.keepIssue.key,
      drafts.refusedIssue.key,
    ];
    for (const key of keys) {
      const d = ((read.decisions as Doc[]) ?? []).find((x) => x.key === key);
      expect(d?.group, `${key} is a merge-or-drop decision`).toBe('merge_or_drop');
      expect((d?.recommended as Doc | undefined)?.by).toBe('rule');
    }
    const merge = await decisionOf(drafts.mergeIssue.key);
    expect((merge?.recommended as Doc | undefined)?.why).toContain(
      `Forge recommends "Merge into ${drafts.twin.key}" because it reads as the same as ${drafts.twin.key}`,
    );
    expect(((merge?.answers as Doc[] | undefined) ?? []).map((a) => a.effect)).toEqual([
      `Moves this draft into ${drafts.twin.key} (a proposed revision of a requirement, a comment on an issue) and drops the draft.`,
      'Drops the draft, naming this question as why.',
      'Keeps it as a draft and changes nothing; Forge asks again after 7 days.',
    ]);
    const left = (read.notDecisions as Doc[]).flatMap((n) => n.keys as string[]);
    for (const key of keys)
      expect(left, `${key} is not left out as awaiting a proposal`).not.toContain(key);
  });

  it('reads a draft issue’s question as Forge asking about a stale draft, never as a run asking', async () => {
    const w = await issueStanding(drafts.dropIssue.key);
    expect(w).toMatchObject({
      kind: 'you',
      act: 'answer whether to merge, drop or keep this draft',
      rule: 'Forge asked about a 9-day-old draft whether to merge, drop or keep it',
    });
  });
});

describe('BC-12: the answer acts by itself and the item leaves Needs you', () => {
  it('drop drops a draft requirement, its reason naming the question', async () => {
    const q = await questionOn({ requirement: drafts.dropReq });
    await answer(q.id, 'stale_draft.drop');
    const move = await lastMove('requirement', await reqId(drafts.dropReq));
    expect(move?.to_status).toBe('dropped');
    expect(move?.reason).toBe(`Dropped on the answer to Forge's merge-or-drop question ${q.id}.`);
    expect(await decisionOf(drafts.dropReq)).toBeUndefined();
    expect(await needsYouKeys()).not.toContain(drafts.dropReq);
  });

  it('drop drops a draft issue through the issue machine, naming the question', async () => {
    const q = await questionOn({ issueId: drafts.dropIssue.id });
    await answer(q.id, 'stale_draft.drop');
    const move = await lastMove('issue', drafts.dropIssue.id);
    expect(move?.to_status).toBe('dropped');
    expect(move?.reason).toContain(`merge-or-drop question ${q.id}`);
    expect(await needsYouKeys()).not.toContain(drafts.dropIssue.key);
  });

  it('merge moves a draft issue into its twin as a comment and drops it naming the twin', async () => {
    const q = await questionOn({ issueId: drafts.mergeIssue.id });
    await answer(q.id, 'stale_draft.merge');
    const move = await lastMove('issue', drafts.mergeIssue.id);
    expect(move?.to_status).toBe('dropped');
    expect(move?.reason).toContain(`Merged into ${drafts.twin.key}`);
    const [comment] = await rows<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${drafts.twin.id} ORDER BY created_at DESC LIMIT 1`,
    );
    expect(comment?.body).toContain(
      `Merged from ${drafts.mergeIssue.key} "Export calls from the list"`,
    );
    expect(comment?.body).toContain(
      "What Export calls from the list means, in the reporter's words.",
    );
    expect(await needsYouKeys()).not.toContain(drafts.mergeIssue.key);
  });

  it('merge moves a draft requirement into its target as a proposed revision and drops it naming the target', async () => {
    const q = await questionOn({ requirement: drafts.mergeReq });
    await answer(q.id, 'stale_draft.merge');
    const target = ok(await as('GET', `/requirements/${drafts.target}`)) as Doc;
    const proposed = (target.revisions as Doc[]).find((r) => r.state === 'proposed');
    expect(proposed?.revision).toBe(2);
    expect((proposed?.spec as Doc | undefined)?.scopeIn).toEqual([
      'Export the call list',
      'CSV with a header row',
    ]);
    expect((proposed?.spec as Doc | undefined)?.personas).toEqual(['Coordinator']);
    expect(((proposed?.criteria as Doc[]) ?? []).map((c) => [c.code, c.body])).toEqual([
      ['BC-1', 'The call list exports to a spreadsheet.'],
      ['BC-2', 'The CSV opens in Excel.'],
    ]);
    const move = await lastMove('requirement', await reqId(drafts.mergeReq));
    expect(move?.to_status).toBe('dropped');
    expect(move?.reason).toBe(
      `Merged into ${drafts.target} on the answer to Forge's merge-or-drop question ${q.id}: its content is the proposed revision r2 of ${drafts.target}.`,
    );
    expect(await decisionOf(drafts.mergeReq)).toBeUndefined();
    expect(await needsYouKeys()).not.toContain(drafts.mergeReq);
  });

  it('keep changes nothing and the sweep does not ask again within the spell', async () => {
    const q = await questionOn({ issueId: drafts.keepIssue.id });
    await answer(q.id, 'stale_draft.keep');
    const [issue] = await rows<{ status: string }>(
      sql`SELECT status FROM issues WHERE id = ${drafts.keepIssue.id}`,
    );
    expect(issue?.status).toBe('draft');
    expect((await questionOn({ issueId: drafts.keepIssue.id })).last.resume).toBeUndefined();
    const { sweepStaleDrafts } = await import('../../src/requirements/stale-drafts.js');
    expect((await sweepStaleDrafts()).asked).toBe(0);
    expect(await decisionOf(drafts.keepIssue.key)).toBeUndefined();
  });
});

describe('BC-12: a merge a rule refuses is refused by name and stays with the master', () => {
  it('an issue merge whose twin has since ended is refused, the draft kept, waiting on the master', async () => {
    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    await withKernelMarker(db, (tx) =>
      tx.execute(sql`UPDATE issues SET status = 'dropped' WHERE id = ${drafts.goneTwin.id}`),
    );
    const q = await questionOn({ issueId: drafts.refusedIssue.id });
    await answer(q.id, 'stale_draft.merge');
    const after = await questionOn({ issueId: drafts.refusedIssue.id });
    expect(after.last.resume).toMatchObject({
      kind: 'refused',
      code: 'STALE_DRAFT_MERGE_TARGET_ENDED',
    });
    const [issue] = await rows<{ status: string }>(
      sql`SELECT status FROM issues WHERE id = ${drafts.refusedIssue.id}`,
    );
    expect(issue?.status).toBe('draft');
    const w = await issueStanding(drafts.refusedIssue.key);
    expect(w).toMatchObject({
      kind: 'master',
      who: 'Master',
      act: 'carry out the answer to the merge-or-drop question by hand',
    });
    expect(String(w.rule)).toContain('(STALE_DRAFT_MERGE_TARGET_ENDED)');
    expect(await needsYouKeys()).not.toContain(drafts.refusedIssue.key);
  });

  it('a requirement merge onto a target with a revision already open is refused, nothing written on the target', async () => {
    const q = await questionOn({ requirement: drafts.refusedReq });
    await answer(q.id, 'stale_draft.merge');
    const after = await questionOn({ requirement: drafts.refusedReq });
    expect(after.last.resume).toMatchObject({ kind: 'refused', code: 'REQUIREMENT_REVISION_OPEN' });
    const target = ok(await as('GET', `/requirements/${drafts.target}`)) as Doc;
    expect((target.revisions as Doc[]).map((r) => r.revision)).toEqual([2, 1]);
    const [req] = await rows<{ status: string }>(
      sql`SELECT status FROM requirements WHERE id = ${await reqId(drafts.refusedReq)}`,
    );
    expect(req?.status).toBe('draft');
    expect(await requirementStanding(drafts.refusedReq)).toMatchObject({
      kind: 'agent',
      who: 'Master',
      act: 'carry out the answer to the merge-or-drop question by hand',
    });
    expect(await needsYouKeys()).not.toContain(drafts.refusedReq);
  });
});

describe('BC-12: a stale draft revision answered "drop" is withdrawn, never stuck', () => {
  let key = '';

  beforeAll(async () => {
    key = await agreedRequirement('Coordinator call notes', { scopeIn: ['Notes per call'] }, [
      { body: 'Each call keeps its notes.' },
    ]);
    ok(
      await as('POST', `/requirements/${key}/revisions`, {
        baseRevision: 1,
        reason: 'someone started an edit once',
        criteria: [
          { code: 'BC-1', body: 'Each call keeps its notes.' },
          { body: 'Notes are searchable.' },
        ],
      }),
    );
    const seq = Number(key.slice(4));
    await db.execute(sql`
      UPDATE requirement_revisions
         SET created_at = ${daysAgo(9)},
             proposed_at = CASE WHEN proposed_at IS NULL THEN NULL ELSE ${daysAgo(9)}::timestamptz END,
             decided_at = CASE WHEN decided_at IS NULL THEN NULL ELSE ${daysAgo(9)}::timestamptz END
       WHERE requirement_id = (SELECT id FROM requirements WHERE project_id = ${projectId} AND req_seq = ${seq})`);
    await db.execute(sql`
      UPDATE requirements SET updated_at = ${daysAgo(8)} WHERE project_id = ${projectId} AND req_seq = ${seq}`);
    const { sweepStaleDrafts } = await import('../../src/requirements/stale-drafts.js');
    await sweepStaleDrafts();
  });

  it('withdraws the draft revision naming the question, and the requirement leaves Needs you', async () => {
    const q = await questionOn({ requirement: key });
    expect(String(q.last.prompt)).toContain('is a draft revision (r2)');
    expect((await decisionOf(key))?.group).toBe('merge_or_drop');
    expect(await needsYouKeys()).toContain(key);

    await answer(q.id, 'stale_draft.drop');

    expect((await questionOn({ requirement: key })).last.resume, 'carried out, not refused').toBe(
      undefined,
    );
    const [r2] = await rows<{ state: string; withdrawn_reason: string | null }>(sql`
      SELECT state, withdrawn_reason FROM requirement_revisions
       WHERE requirement_id = ${await reqId(key)} AND revision = 2`);
    expect(r2).toEqual({
      state: 'withdrawn',
      withdrawn_reason: `Withdrawn on the answer to Forge's merge-or-drop question ${q.id}.`,
    });
    const detail = ok(await as('GET', `/requirements/${key}`)) as Doc;
    expect(detail.status).toBe('agreed');
    expect(detail.latestRevision).toEqual({ revision: 1, state: 'current' });
    expect(((detail.criteria as Doc[]) ?? []).map((c) => c.body)).toEqual([
      'Each call keeps its notes.',
    ]);
    expect(await decisionOf(key)).toBeUndefined();
    expect(await needsYouKeys(), 'it reads as it did before the draft').not.toContain(key);
  });

  it('refuses to propose a withdrawn revision by name, and the next draft can be written', async () => {
    const refused = await as('POST', `/requirements/${key}/revisions/2/propose`, {});
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.json)).toContain('REQUIREMENT_REVISION_WITHDRAWN');
    ok(
      await as('POST', `/requirements/${key}/revisions`, {
        baseRevision: 1,
        reason: 'the edit, started again',
        criteria: [{ code: 'BC-1', body: 'Each call keeps its notes.' }],
      }),
    );
    const [r3] = await rows<{ state: string }>(sql`
      SELECT state FROM requirement_revisions WHERE requirement_id = ${await reqId(key)} AND revision = 3`);
    expect(r3?.state).toBe('draft');
  });
});
