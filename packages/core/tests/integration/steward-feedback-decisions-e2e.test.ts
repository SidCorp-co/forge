// REQ-48 BC-5, round 2b: a stuck feedback item whose next act is a person's gets the steward's
// question (the BC-5 judge on round 2: it could get none). One nobody triages is asked keep or
// decline, a fix nobody verifies verify, reopen or keep; the question names the item beside it,
// never as its reporter's clarification, and each answer acts as the answerer by the feedback
// module's own rules. Only the steward asks a decision, through its own door; the general ask door
// refuses the steward's option ids. The one-off voids the stale-draft questions still open.
//
// @direct-test-of packages/core/src/steward/door-decide.ts
// @direct-test-of packages/core/src/steward/decision-ask.ts
// @direct-test-of packages/core/src/steward/decision-subjects.ts
// @direct-test-of packages/core/src/steward/retire-stale-drafts.ts
// @direct-test-of packages/core/src/feedback/steward-settle.ts
// @direct-test-of packages/core/src/questions/steward-options.ts

import { STEWARD_DECISION_OPTION_IDS as IDS } from '@forge/contracts/steward';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeWorld, type Doc, settleOutbox } from '../helpers/ecosystem-world.js';
import { createTestFeedback, rows } from '../helpers/factories.js';
import {
  answer,
  decisionOf,
  diagnose,
  draftRequirement,
  fbId,
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

describe('a stuck feedback item gets its question (REQ-48 BC-5, the BC-5 judge on round 2)', () => {
  it('asks a feedback item nobody triages keep or decline, beside the item, never as its clarification', async () => {
    const key = await createTestFeedback(world.projectId, world.reporterId, 41);
    const fb: Subject = { kind: 'feedback', id: await fbId(key), key };
    world.standings = [stuck(fb, 'standing.act.triageIt')];
    const said = await diagnose(fb, {
      recommended: 'drop',
      why: 'it repeats FB-12, which was declined',
    });
    expect(said).not.toContain('Ask nothing');
    const q = await questionOn(fb);
    expect(q?.status).toBe('open');
    // a reporter's clarification is feedback_id; the steward's decision only names the item
    expect(q?.feedback_id).toBeNull();
    expect(optionIds(q)).toEqual([IDS.keep, IDS.drop]);
    expect(((q?.last.options as Doc[]) ?? []).map((o) => o.label)).toEqual([
      'Keep it waiting',
      'Decline it: it is not work',
    ]);
    expect(String(q?.last.prompt)).toContain(`${key} "feedback 41"`);
    expect(String(q?.last.prompt)).toContain('Keep it waiting for triage, or decline it?');

    // Needs you shows it as the steward's decision, opening the item, each button naming its effect
    const d = await decisionOf(key);
    if (!d) throw new Error(`${key}'s decision is not in Needs you`);
    expect(d.opens).toEqual({ kind: 'feedback', key });
    expect(d.recommended).toMatchObject({ answerId: IDS.drop, by: 'steward' });
    expect((d.answers as Doc[]).map((a) => [a.id, a.needsReason, a.effect])).toEqual([
      [IDS.drop, true, `Declines ${key} as you; its reporter reads your reason.`],
      [
        IDS.keep,
        true,
        `Keeps ${key} as it is until its standing moves, with your reason; the steward does not ask again until then.`,
      ],
    ]);

    // the answer declines it as the answerer, with the reason the reporter reads
    const done = await answer(q?.id ?? '', { optionId: IDS.drop, note: 'Same as FB-12.' });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const [row] = await rows<{ status: string }>(
      sql`SELECT status FROM feedback WHERE id = ${fb.id}`,
    );
    expect(row?.status).toBe('declined');
    const [decision] = await rows<{ decision: string; reason: string; decided_by: string }>(sql`
      SELECT decision, reason, decided_by FROM feedback_decisions WHERE feedback_id = ${fb.id}`);
    expect(decision).toEqual({
      decision: 'declined',
      reason: 'Same as FB-12.',
      decided_by: world.ownerId,
    });
    const acts = await rows<{ door: string; did: string }>(sql`
      SELECT door, did FROM steward_acts WHERE run_id = ${world.lastRunId} ORDER BY at`);
    expect(acts.map((a) => a.door)).toEqual([
      `POST /api/projects/${world.projectId}/steward-runs/${world.lastRunId}/decisions`,
      `POST /api/projects/${world.projectId}/feedback/${key}/triage`,
    ]);
    expect(await decisionOf(key)).toBeUndefined();
  });

  it('asks a fix nobody verifies verify, reopen or keep, and the verify settles it on the reporter’s behalf', async () => {
    const carrier = await issueAt(731, 'Fix the saved board', 'closed');
    const key = await createTestFeedback(world.projectId, world.reporterId, 42, [carrier.id]);
    const fb: Subject = { kind: 'feedback', id: await fbId(key), key };
    world.standings = [stuck(fb, 'standing.act.verifyFix')];
    await diagnose(fb, { recommended: 'verify', why: 'the fix shipped and the board saves now' });
    const q = await questionOn(fb);
    expect(optionIds(q)).toEqual([IDS.verify, IDS.reopen, IDS.keep]);
    const bare = await answer(q?.id ?? '', { optionId: IDS.reopen });
    expect([bare.status, bare.json.code]).toEqual([422, 'STEWARD_DECISION_REASON_REQUIRED']);
    const done = await answer(q?.id ?? '', { optionId: IDS.verify });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const [row] = await rows<{ status: string }>(
      sql`SELECT status FROM feedback WHERE id = ${fb.id}`,
    );
    expect(row?.status).toBe('verified');
  });

  it("asks nothing where the item's wait is somebody's act already, or it reads no stuck code", async () => {
    const key = await createTestFeedback(world.projectId, world.reporterId, 43);
    const fb: Subject = { kind: 'feedback', id: await fbId(key), key };
    world.standings = [stuck(fb, 'standing.act.confirmAnswer')];
    expect(
      await diagnose(fb, { recommended: 'keep', why: 'the reporter has not said yet' }),
    ).toContain('Ask nothing');
    world.standings = [];
    expect(
      await diagnose(fb, { recommended: 'keep', why: 'the reporter has not said yet' }),
    ).toContain('Ask nothing');
    expect(await questionOn(fb)).toBeUndefined();
  });

  it('refuses a verify the item does not read resolved for, by its own name, and leaves the question open', async () => {
    const key = await createTestFeedback(world.projectId, world.reporterId, 44);
    const fb: Subject = { kind: 'feedback', id: await fbId(key), key };
    world.standings = [stuck(fb, 'standing.act.verifyFix')];
    await diagnose(fb, { recommended: 'verify', why: 'the fix shipped' });
    const q = await questionOn(fb);
    const refused = await answer(q?.id ?? '', { optionId: IDS.verify });
    expect(refused.json.code, JSON.stringify(refused.json)).toBe('FEEDBACK_NOT_RESOLVED');
    expect((await questionOn(fb))?.status).toBe('open');
  });
});

describe('one door asks a steward decision', () => {
  it('refuses the steward’s option ids on the general ask door, naming the steward’s', async () => {
    const issue = await issueAt(721, 'Anything', 'draft');
    const refused = await world.say('owner', 'POST', '/api/questions', {
      issueId: issue.id,
      prompt: 'Drop it?',
      options: [IDS.drop, IDS.keep].map((id) => ({
        id,
        label: id,
        authority: 'writer',
        bindsTo: 'this_call',
        executedBy: 'core',
      })),
      recommendedOptionId: IDS.drop,
      blockerKind: 'human',
    });
    expect([refused.status, refused.json.code]).toEqual([422, 'QUESTION_OPTIONS_STEWARDS']);
    expect(JSON.stringify(refused.json)).toContain('/steward-runs/:runId/decisions');
  });

  it('refuses a decision asked by anyone but the steward, and about an item the project lacks', async () => {
    const issue = await issueAt(722, 'Anything else', 'draft');
    await diagnose(issue, { recommended: 'drop', why: 'nothing asks for it yet' });
    const body = {
      about: issue.key,
      prompt: 'Drop it?',
      options: [
        { id: IDS.drop, label: 'Drop it' },
        { id: IDS.keep, label: 'Keep it' },
      ],
      recommendedOptionId: IDS.drop,
      basis: 'b',
    };
    const path = `/api/projects/${world.projectId}/steward-runs/${world.lastRunId}/decisions`;
    const owner = await world.say('owner', 'POST', path, body);
    expect([owner.status, owner.json.code]).toEqual([403, 'STEWARD_DECISION_FORBIDDEN']);
    const unknown = await world.say('steward', 'POST', path, { ...body, about: 'FB-999' });
    expect([unknown.status, unknown.json.code]).toEqual([404, 'STEWARD_DECISION_SUBJECT_UNKNOWN']);
  });
});

/** A question the retired stale-draft sweep asked on `on`, open, or answered with `chosen`. */
async function staleDraftQuestion(
  on: { issueId?: string; requirementId?: string },
  answered?: { chosen: string; resume?: Doc },
): Promise<string> {
  const step = {
    round: 1,
    answerShape: 'choice',
    prompt: 'A draft nobody touched for 7 days. Drop it, or keep it?',
    askedAt: new Date().toISOString(),
    options: ['stale_draft.drop', 'stale_draft.keep'].map((id) => ({
      id,
      label: id,
      authority: 'writer',
      bindsTo: 'this_call',
      executedBy: 'core',
      fingerprint: 'stale-draft:old',
    })),
    recommendedOptionId: 'stale_draft.drop',
    ...(answered
      ? {
          chosenOptionId: answered.chosen,
          answeredBy: world.ownerId,
          answeredAt: new Date().toISOString(),
          note: 'Nobody needs it.',
          ...(answered.resume ? { resume: answered.resume } : {}),
        }
      : {}),
  };
  const [made] = await rows<{ id: string }>(sql`
    INSERT INTO agent_questions (id, project_id, issue_id, requirement_id, status, blocker_kind, steps)
    VALUES (gen_random_uuid(), ${world.projectId}, ${on.issueId ?? null}, ${on.requirementId ?? null},
            ${answered ? 'answered' : 'open'}, 'human', ${JSON.stringify([step])}::jsonb)
    RETURNING id`);
  return made?.id ?? '';
}

describe('the one-off retires the stale-draft questions', () => {
  it('voids each open merge-or-drop question once, naming why, and a second boot does nothing', async () => {
    const issue = await issueAt(741, 'An old draft', 'draft');
    const open = await staleDraftQuestion({ issueId: issue.id });
    // answered drop the retired consumer never carried out: on an issue, on a requirement
    const unactedIssue = await issueAt(742, 'An answered draft', 'draft');
    const issueDrop = await staleDraftQuestion(
      { issueId: unactedIssue.id },
      { chosen: 'stale_draft.drop' },
    );
    const unactedReq = await draftRequirement('Print the call list');
    const reqDrop = await staleDraftQuestion(
      { requirementId: unactedReq.id },
      { chosen: 'stale_draft.drop' },
    );
    // one the consumer refused by rule, which records its outcome: left as it is
    const refusedIssue = await issueAt(743, 'A refused draft', 'draft');
    await staleDraftQuestion(
      { issueId: refusedIssue.id },
      {
        chosen: 'stale_draft.drop',
        resume: { kind: 'refused', code: 'X', detail: 'refused', at: new Date().toISOString() },
      },
    );
    world.standings = [stuck(issue, 'issues.standing.act.takeOnOrDrop')];
    const { retireStaleDraftQuestionsOnce } = await import(
      '../../src/steward/retire-stale-drafts.js'
    );
    const report = await retireStaleDraftQuestionsOnce();
    expect(report?.refusals).toEqual([]);
    expect(report?.voided).toBe(1);
    expect(report?.rediagnosed).toBe(1);
    expect(report?.carried).toEqual([
      { questionId: issueDrop, outcome: 'carried' },
      { questionId: reqDrop, outcome: 'carried' },
    ]);
    const [voided] = await rows<{ status: string; void_reason: string }>(sql`
      SELECT status, void_reason FROM agent_questions WHERE id = ${open}`);
    expect(voided?.status).toBe('void');
    expect(voided?.void_reason).toContain("The steward asks a stuck draft's decision");
    const statusOf = async (table: 'issues' | 'requirements', id: string) =>
      (
        await rows<{ status: string }>(sql`SELECT status FROM ${sql.raw(table)} WHERE id = ${id}`)
      )[0]?.status;
    expect(await statusOf('issues', unactedIssue.id)).toBe('dropped');
    expect((await lastMove('issue', unactedIssue.id))?.reason).toBe(
      `Dropped on the answer to Forge's merge-or-drop question ${issueDrop}: Nobody needs it.`,
    );
    expect(await statusOf('requirements', unactedReq.id)).toBe('dropped');
    expect(await statusOf('issues', refusedIssue.id)).toBe('draft');
    await settleOutbox();
    expect(await retireStaleDraftQuestionsOnce()).toBeNull();
  });
});
