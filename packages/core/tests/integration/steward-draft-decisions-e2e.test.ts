// REQ-48 BC-5, round 2b: a stuck draft is the steward's to ask, and the stale-draft sweep that asked
// merge-or-drop beside it is gone. A stuck draft requirement is asked merge (into the live
// requirement it repeats), drop or keep; a draft revision of an agreed one withdraw or keep; a draft
// issue may be asked merge into the live issue it repeats. Each answer acts as the answerer in the
// answer's transaction, a rule it breaks refused by name with the question left open, and Needs you
// names each button's effect on the item. A stuck feedback item's decision, the one door and the
// one-off that retires the stale-draft questions: `steward-feedback-decisions-e2e.test.ts`.
//
// @direct-test-of packages/core/src/steward/door-decide.ts
// @direct-test-of packages/core/src/steward/decision-act.ts
// @direct-test-of packages/core/src/steward/decision-subjects.ts
// @direct-test-of packages/core/src/steward/decision-merge.ts
// @direct-test-of packages/core/src/requirements/steward-decision.ts
// @direct-test-of packages/core/src/requirements/steward-asked.ts

import { STEWARD_DECISION_OPTION_IDS as IDS, stewardMergeOptionId } from '@forge/contracts/steward';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { closeWorld, type Doc, ok } from '../helpers/ecosystem-world.js';
import { createTestFeedback, rows } from '../helpers/factories.js';
import {
  agreedRequirement,
  answer,
  as,
  decisionOf,
  diagnose,
  draftRequirement,
  issueAt,
  lastMove,
  optionIds,
  questionOn,
  type Subject,
  startStewardDecideWorld,
  stuck,
  world,
} from '../helpers/steward-decide-world.js';

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/llm/chat.js')>()),
  openChat: (await import('../helpers/scripted-chat.js')).scriptedOpenChat,
}));

beforeAll(startStewardDecideWorld, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a stuck draft requirement is the steward’s to ask (the stale-draft sweep replaced)', () => {
  let target: Subject;

  beforeAll(async () => {
    // the target names who it is for, as an agreed requirement must (ISS-453's ready checklist)
    target = await agreedRequirement(
      'Call list export',
      { scopeIn: ['Export the call list'], personas: ['Call centre lead'] },
      [{ body: 'The call list exports to a spreadsheet.' }],
    );
  });

  it('asks merge, drop or keep, and the requirement waits on a signer answering it', async () => {
    const req = await draftRequirement('Fax the call list');
    world.standings = [stuck(req, 'standing.act.proposeR')];
    await diagnose(req, { recommended: 'drop', into: target.key, why: 'nothing asks for a fax' });
    const q = await questionOn(req);
    expect(optionIds(q)).toEqual([stewardMergeOptionId(target.key), IDS.drop, IDS.keep]);
    expect(((q?.last.options as Doc[]) ?? [])[0]?.label).toBe(
      `Merge it into ${target.key}: Call list export`,
    );
    const standing = (ok(await as('GET', `/requirements/${req.key}`)).standing as Doc)
      .waitingOn as Doc;
    expect(standing).toMatchObject({ kind: 'you', act: "answer the steward's question" });
    const d = await decisionOf(req.key);
    expect(((d?.answers as Doc[] | undefined) ?? []).map((a) => a.effect)).toEqual([
      `Drops ${req.key} as you, with your reason.`,
      `Proposes what ${req.key} adds as a revision of ${target.key}, then drops ${req.key}, as you.`,
      `Keeps ${req.key} as it is until its standing moves, with your reason; the steward does not ask again until then.`,
    ]);
    ok(await answer(q?.id ?? '', { optionId: IDS.drop, note: 'Nobody faxes any more.' }));
    const move = await lastMove('requirement', req.id);
    expect(move?.to_status).toBe('dropped');
    expect(move?.reason).toBe(
      `Dropped on the answer to the steward's question ${q?.id}: Nobody faxes any more.`,
    );
    expect(await decisionOf(req.key)).toBeUndefined();
  });

  it('merges a draft into the requirement it repeats as a proposed revision, and drops it naming that one', async () => {
    const req = await draftRequirement(
      'Export the call list as CSV',
      { scopeIn: ['Export the call list', 'CSV with a header row'], personas: ['Coordinator'] },
      [{ body: 'The call list exports to a spreadsheet.' }, { body: 'The CSV opens in Excel.' }],
    );
    world.standings = [stuck(req, 'standing.act.proposeR')];
    await diagnose(req, {
      recommended: 'merge',
      into: target.key,
      why: 'it asks what REQ already does',
    });
    const q = await questionOn(req);
    ok(await answer(q?.id ?? '', { optionId: stewardMergeOptionId(target.key) }));
    const read = ok(await as('GET', `/requirements/${target.key}`)) as Doc;
    const proposed = (read.revisions as Doc[]).find((r) => r.state === 'proposed');
    expect(proposed?.revision).toBe(2);
    expect((proposed?.spec as Doc | undefined)?.personas).toEqual([
      'Call centre lead',
      'Coordinator',
    ]);
    expect(((proposed?.criteria as Doc[]) ?? []).map((c) => [c.code, c.body])).toEqual([
      ['BC-1', 'The call list exports to a spreadsheet.'],
      ['BC-2', 'The CSV opens in Excel.'],
    ]);
    const move = await lastMove('requirement', req.id);
    expect(move?.to_status).toBe('dropped');
    expect(move?.reason).toContain(
      `Merged into ${target.key} on the answer to the steward's question`,
    );
    expect(move?.reason).toContain(`its content is the proposed revision r2 of ${target.key}`);
  });

  it('refuses a merge onto a target with a revision already open, by name, writing nothing', async () => {
    const req = await draftRequirement('Export the call list as XLSX', {}, [
      { body: 'The export is an XLSX file.' },
    ]);
    world.standings = [stuck(req, 'standing.act.proposeR')];
    await diagnose(req, { recommended: 'merge', into: target.key, why: 'it repeats the export' });
    const q = await questionOn(req);
    const refused = await answer(q?.id ?? '', { optionId: stewardMergeOptionId(target.key) });
    expect(refused.json.code, JSON.stringify(refused.json)).toBe('REQUIREMENT_REVISION_OPEN');
    expect((await questionOn(req))?.status).toBe('open');
    const read = ok(await as('GET', `/requirements/${target.key}`)) as Doc;
    expect((read.revisions as Doc[]).map((r) => r.revision)).toEqual([2, 1]);
    const [row] = await rows<{ status: string }>(
      sql`SELECT status FROM requirements WHERE id = ${req.id}`,
    );
    expect(row?.status).toBe('draft');
  });

  it('asks a draft revision of an agreed requirement withdraw or keep, and withdraws it keeping what was agreed', async () => {
    const req = await agreedRequirement('Coordinator call notes', { scopeIn: ['Notes per call'] }, [
      { body: 'Each call keeps its notes.' },
    ]);
    ok(
      await as('POST', `/requirements/${req.key}/revisions`, {
        baseRevision: 1,
        reason: 'someone started an edit once',
        criteria: [
          { code: 'BC-1', body: 'Each call keeps its notes.' },
          { body: 'Notes are searchable.' },
        ],
      }),
    );
    world.standings = [stuck(req, 'standing.act.proposeR')];
    expect(
      await diagnose(req, { recommended: 'merge', into: target.key, why: 'it repeats the export' }),
    ).toContain('offers withdraw, keep');
    await diagnose(req, { recommended: 'withdraw', why: 'nobody came back to the edit' });
    const q = await questionOn(req);
    expect(optionIds(q)).toEqual([IDS.withdraw, IDS.keep]);
    ok(await answer(q?.id ?? '', { optionId: IDS.withdraw, note: 'Abandoned edit.' }));
    const [r2] = await rows<{ state: string; withdrawn_reason: string | null }>(sql`
      SELECT state, withdrawn_reason FROM requirement_revisions
       WHERE requirement_id = ${req.id} AND revision = 2`);
    expect(r2).toEqual({
      state: 'withdrawn',
      withdrawn_reason: `Withdrawn on the answer to the steward's question ${q?.id}: Abandoned edit.`,
    });
    const detail = ok(await as('GET', `/requirements/${req.key}`)) as Doc;
    expect(detail.status).toBe('agreed');
  });

  it('refuses a withdraw whose draft revision was started after the question, leaving that draft', async () => {
    const req = await agreedRequirement('Coordinator call tags', { scopeIn: ['Tags per call'] }, [
      { body: 'Each call keeps its tags.' },
    ]);
    const edit = (body: string) =>
      as('POST', `/requirements/${req.key}/revisions`, {
        baseRevision: 1,
        reason: 'an edit started',
        criteria: [{ code: 'BC-1', body: 'Each call keeps its tags.' }, { body }],
      });
    ok(await edit('Tags are searchable.'));
    world.standings = [stuck(req, 'standing.act.proposeR')];
    await diagnose(req, { recommended: 'withdraw', why: 'nobody came back to the edit' });
    const q = await questionOn(req);
    // r2 goes another way and a new edit, r3, starts after the question was asked
    await db.execute(sql`
      UPDATE requirement_revisions SET state = 'withdrawn', withdrawn_reason = 'gone another way',
             withdrawn_at = now(), withdrawn_by = ${world.ownerId}
       WHERE requirement_id = ${req.id} AND revision = 2`);
    ok(await edit('Tags are colour coded.'));
    const refused = await answer(q?.id ?? '', { optionId: IDS.withdraw, note: 'Abandoned edit.' });
    expect(refused.json.code, JSON.stringify(refused.json)).toBe('STEWARD_DECISION_STALE');
    expect(JSON.stringify(refused.json)).toContain('r3 was started after this question was asked');
    expect((await questionOn(req))?.status).toBe('open');
    const [r3] = await rows<{ state: string }>(sql`
      SELECT state FROM requirement_revisions WHERE requirement_id = ${req.id} AND revision = 3`);
    expect(r3?.state).toBe('draft');
  });
});

describe('a draft issue that repeats a live issue is asked merge', () => {
  it('copies its text to the live issue as a comment and drops it, naming that issue', async () => {
    const draft = await issueAt(711, 'Export calls from the list', 'draft');
    const twin = await issueAt(712, 'Export calls from the list', 'open');
    world.standings = [stuck(draft, 'issues.standing.act.takeOnOrDrop')];
    await diagnose(draft, {
      recommended: 'merge',
      into: twin.key,
      why: 'it asks what the twin asks',
    });
    const q = await questionOn(draft);
    expect(optionIds(q)).toContain(stewardMergeOptionId(twin.key));
    ok(await answer(q?.id ?? '', { optionId: stewardMergeOptionId(twin.key) }));
    const move = await lastMove('issue', draft.id);
    expect(move?.to_status).toBe('dropped');
    expect(move?.reason).toContain(`Merged into ${twin.key}`);
    const [comment] = await rows<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${twin.id} ORDER BY created_at DESC LIMIT 1`,
    );
    expect(comment?.body).toContain(`Merged from ${draft.key} "Export calls from the list"`);
    expect(comment?.body).toContain(
      "What Export calls from the list means, in the reporter's words.",
    );
  });

  it('refuses a merge into an issue that has since ended, by name, the draft kept', async () => {
    const draft = await issueAt(713, 'Archive old calls', 'draft');
    const twin = await issueAt(714, 'Archive old calls', 'open');
    world.standings = [stuck(draft, 'issues.standing.act.takeOnOrDrop')];
    const said = await diagnose(draft, {
      recommended: 'merge',
      into: twin.key,
      why: 'it asks the very same thing',
    });
    const q = await questionOn(draft);
    expect(q, said).toBeDefined();
    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    await withKernelMarker(db, (tx) =>
      tx.execute(sql`UPDATE issues SET status = 'dropped' WHERE id = ${twin.id}`),
    );
    const refused = await answer(q?.id ?? '', { optionId: stewardMergeOptionId(twin.key) });
    expect([refused.status, refused.json.code]).toEqual([409, 'STEWARD_MERGE_TARGET_ENDED']);
    const [row] = await rows<{ status: string }>(
      sql`SELECT status FROM issues WHERE id = ${draft.id}`,
    );
    expect(row?.status).toBe('draft');
    expect((await questionOn(draft))?.status).toBe('open');
  });

  it('refuses a merge whose draft carries feedback, which the merge would strand', async () => {
    const draft = await issueAt(715, 'Show the saved board', 'draft');
    const twin = await issueAt(716, 'Show the saved board', 'open');
    await createTestFeedback(world.projectId, world.reporterId, 45, [draft.id]);
    world.standings = [stuck(draft, 'issues.standing.act.takeOnOrDrop')];
    await diagnose(draft, {
      recommended: 'merge',
      into: twin.key,
      why: 'it asks the very same thing',
    });
    const q = await questionOn(draft);
    const refused = await answer(q?.id ?? '', { optionId: stewardMergeOptionId(twin.key) });
    expect([refused.status, refused.json.code]).toEqual([409, 'STEWARD_MERGE_HAS_DEPENDENTS']);
    expect(JSON.stringify(refused.json)).toContain('FB-45');
  });
});
