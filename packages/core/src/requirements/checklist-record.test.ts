// The ready and acceptance checklists as a requirement's record answers them (REQ-34 r2 BC-1,
// BC-18, BC-24; Requirement lifecycle r15 ready_check, acceptance_check): only a blocking gap stops
// the move, named on its question in plain words; a non-blocking one takes its recommended answer.

import {
  REQUIREMENT_ACCEPTANCE_CHECKLIST,
  REQUIREMENT_READY_CHECKLIST,
} from '@forge/contracts/checklist-registry';
import { checklistRefusals, evaluateChecklist } from '@forge/contracts/checklists';
import { describe, expect, it } from 'vitest';
import {
  acceptanceAnswersOf,
  goalAnswers,
  type ReadyFacts,
  readyAnswersOf,
} from './checklist-record.js';

const ready: ReadyFacts = {
  key: 'REQ-7',
  head: 2,
  spec: {
    goal: 'Problem: referrals are lost.\nValue: every referral reaches a clinician.\nMeasured by: lost referrals per month.\nRoadmap: now.',
    personas: ['Referral manager'],
    scopeOut: ['Billing'],
    openQuestions: [],
  },
  kind: 'process',
  criteria: ['BC-1', 'BC-2'],
  openBlocking: [],
  designs: [{ flow: 'referral-intake', approvedRevision: 3 }],
  writtenLang: 'en',
};

// adminhub-api REQ-2 r1 on dev, 2026-10-22, written in Vietnamese: its agree was refused CHECKLIST_INCOMPLETE
// "Its goal does not state the value it gives, after "Value:"" though it does, under its own labels
const ADMINHUB_REQ2_GOAL = [
  'Người và agent làm AdminHub API có DB MySQL local giống schema release/stg, dựng hoặc reset bằng một lệnh, mỗi lượt chạy có DB riêng, không bao giờ chạm môi trường thật.', // i18n-allow: the requirement as written on dev
  'Vấn đề: hiện DB test chỉ được dựng tay một lần, chưa chạy trigger seeder, chưa có dữ liệu mẫu, và các worktree chạy song song có thể ghi đè lên nhau.', // i18n-allow: the requirement as written on dev
  'Giá trị: test và phát triển chạy được ngay trên máy, kết quả lặp lại được, không phụ thuộc staging.', // i18n-allow: the requirement as written on dev
  'Đo bằng: bộ test chạy xanh trên DB mới dựng; DB mới sẵn sàng trong vài phút; không lượt chạy nào hỏng vì lượt khác.', // i18n-allow: the requirement as written on dev
].join('\n');

const judge = (facts: ReadyFacts) =>
  evaluateChecklist(REQUIREMENT_READY_CHECKLIST, { given: {}, record: readyAnswersOf(facts) });

describe('the ready checklist, read from the head revision', () => {
  it('is complete for a head that answers every required question', () => {
    const e = judge(ready);
    expect(e.complete).toBe(true);
    expect(e.answers.find((a) => a.question === 'roadmap')).toMatchObject({
      value: 'now.',
      provenance: 'given',
    });
  });

  it('stops on each blocking gap, naming its question on its path in plain words', () => {
    const e = judge({
      ...ready,
      spec: { goal: 'Problem: referrals are lost.', personas: [] },
      criteria: [],
      designs: [],
      openBlocking: [{ question: 'Who signs the referral?', whoAnswers: 'the clinic owner' }],
    });
    const refusals = checklistRefusals(e);
    expect(refusals.map((r) => r.path)).toEqual([
      '/answers/who',
      '/answers/value',
      '/answers/measured',
      '/answers/criteria',
      '/answers/questions',
      '/answers/workflows',
    ]);
    expect(refusals.every((r) => r.code === 'CHECKLIST_INCOMPLETE')).toBe(true);
    expect(refusals.find((r) => r.question === 'questions')?.detail).toContain(
      '"Who signs the referral?" (answered by the clinic owner)',
    );
    expect(refusals.find((r) => r.question === 'value')?.detail).toContain('after "Value:"');
  });

  it('names the routes that link a design and trace a criterion to its steps, when it links none', () => {
    const [gap] = checklistRefusals(judge({ ...ready, designs: [] }));
    expect(gap?.question).toBe('workflows');
    expect(gap?.detail).toContain(
      'POST /api/projects/:id/requirements/REQ-7/workflows { "workflowId": <design uuid> }',
    );
    expect(gap?.detail).toContain('PUT /api/projects/:id/requirements/:req/criteria/:code/steps');
  });

  it('takes the recommended answer for kind, out of scope and roadmap, recorded as assumed', () => {
    const e = judge({
      ...ready,
      kind: null,
      spec: { ...ready.spec, goal: 'Problem: a.\nValue: b.\nMeasured by: c.', scopeOut: [] },
    });
    expect(e.complete).toBe(true);
    const assumed = e.answers.filter((a) => a.provenance === 'assumed').map((a) => a.question);
    expect(assumed).toEqual(['kind', 'outOfScope', 'roadmap']);
  });

  it("reads a Vietnamese requirement's goal under its own labels (adminhub-api REQ-2)", () => {
    const e = judge({
      ...ready,
      writtenLang: 'vi',
      spec: { ...ready.spec, goal: ADMINHUB_REQ2_GOAL },
    });
    expect(checklistRefusals(e)).toEqual([]);
    const value = e.answers.find((a) => a.question === 'value');
    expect(value?.value).toMatch(/^test và phát triển chạy được ngay trên máy/); // i18n-allow: the requirement as written on dev
    expect(e.answers.find((a) => a.question === 'measured')?.value).toMatch(/^bộ test chạy xanh/); // i18n-allow: the requirement as written on dev
  });

  it('reads the English labels in a Vietnamese requirement too, as its r2 wrote them', () => {
    const r2 = ADMINHUB_REQ2_GOAL.replace(/^Vấn đề:/m, 'Problem:').replace(/^Giá trị:/m, 'Value:'); // i18n-allow: the labels it swapped
    expect(Object.keys(goalAnswers(r2, 'vi')).sort()).toEqual(['measured', 'problem', 'value']);
  });

  it("names the requirement's own label in a gap, and reads no Vietnamese label in an English one", () => {
    const vi = judge({ ...ready, writtenLang: 'vi', spec: { ...ready.spec, goal: 'Vấn đề: a.' } }); // i18n-allow: a Vietnamese label
    expect(checklistRefusals(vi).find((r) => r.question === 'value')?.detail).toContain(
      'after "Giá trị:" or "Value:"', // i18n-allow: the Vietnamese label named
    );
    expect(goalAnswers('Problem: a.\nGiá trị: b.', 'en')).toEqual({ problem: 'a.' }); // i18n-allow: a Vietnamese label an English requirement does not read
  });

  it('reads a goal that labels nothing as its problem alone', () => {
    expect(goalAnswers('Referral managers see their own referrals')).toEqual({
      problem: 'Referral managers see their own referrals',
    });
    expect(goalAnswers('Value: x\nsomething else')).toEqual({
      value: 'x',
      problem: 'something else',
    });
    expect(goalAnswers('   ')).toEqual({});
  });

  // forge-dev REQ-5 r5, 2026-10-28: the first accept was refused for value and measured only; with
  // "Value:" and "Measured by:" lines added, the next was refused for the problem, because once any
  // line was labelled the unlabelled first line no longer read as it. Every gap names itself at
  // once, and adding one label never takes another answer away.
  it('names every goal gap in one pass, and keeps the unlabelled opening as the problem once labels are added', () => {
    const opening = 'Referral managers lose referrals between intake and triage.';
    const gapsOf = (goal: string) =>
      checklistRefusals(judge({ ...ready, spec: { ...ready.spec, goal } }))
        .map((r) => r.question)
        .filter((q) => q !== null && ['problem', 'value', 'measured'].includes(q));

    expect(gapsOf(opening)).toEqual(['value', 'measured']);
    const labelled = `${opening}\nValue: every referral reaches a clinician.\nMeasured by: lost referrals per month.`;
    expect(gapsOf(labelled)).toEqual([]);
    expect(goalAnswers(labelled).problem).toBe(opening);
    // an explicit Problem: line still states it
    expect(goalAnswers(`${opening}\nProblem: lost referrals.\nValue: v.`).problem).toBe(
      'lost referrals.',
    );
  });

  // The judge's goal on dev.347 (ISS-732 c1): the Value: line ABOVE the unlabelled problem line made
  // the problem read as missing, the REQ-5 refusal again.
  it('reads an unlabelled line as the problem wherever it stands, between or after labels', () => {
    const opening = 'Referral managers lose referrals between intake and triage.';
    const value = 'every referral reaches a clinician.';
    const measured = 'lost referrals per month.';
    const gapsOf = (goal: string) =>
      checklistRefusals(judge({ ...ready, spec: { ...ready.spec, goal } }))
        .map((r) => r.question)
        .filter((q) => q !== null && ['problem', 'value', 'measured'].includes(q));

    const judged = `Value: ${value}\n${opening}\nMeasured by: ${measured}`;
    expect(gapsOf(judged)).toEqual([]);
    expect(goalAnswers(judged)).toEqual({ problem: opening, value, measured });
    expect(goalAnswers(`Value: ${value}\nMeasured by: ${measured}\n${opening}`).problem).toBe(
      opening,
    );
    // every unlabelled line is the problem, in the order written
    expect(goalAnswers(`first.\nValue: v.\nsecond.`).problem).toBe('first.\nsecond.');
    // an explicit Problem: line wins over unlabelled lines
    expect(goalAnswers(`Value: v.\n${opening}\nProblem: lost.`).problem).toBe('lost.');
    // a label with no text states nothing, and the unlabelled line still does
    expect(goalAnswers(`Value:\n${opening}`)).toEqual({ problem: opening });
  });

  it('reads an indented line under a label as that label continuing, never as the problem', () => {
    expect(goalAnswers('Value: every referral\n  reaches a clinician.\nMeasured by: m.')).toEqual({
      value: 'every referral\nreaches a clinician.',
      measured: 'm.',
    });
    expect(goalAnswers('Value:\n  reaches a clinician.')).toEqual({
      value: 'reaches a clinician.',
    });
    // a blank line ends the continuation, and an indented line under no label is unlabelled
    expect(goalAnswers('Value: v.\n\n  stray.')).toEqual({ value: 'v.', problem: 'stray.' });
    expect(goalAnswers('  Value: v.\nMeasured by: m.')).toEqual({ value: 'v.', measured: 'm.' });
    // a line under a label that is already answered continues nothing and is dropped by the label
    expect(goalAnswers('Value: a.\nValue: b.\n  c.')).toEqual({ value: 'a.' });
  });

  it('says where the problem line goes when it is still missing', () => {
    const gap = checklistRefusals(
      judge({ ...ready, spec: { ...ready.spec, goal: 'Value: v.\nMeasured by: m.' } }),
    ).find((r) => r.question === 'problem');
    expect(gap?.path).toBe('/answers/problem');
    expect(gap?.detail).toContain('a line of its own with no label, or after "Problem:"');
  });

  it('names every question a requirement with no current revision leaves open', () => {
    const e = judge({ ...ready, head: null });
    expect(e.complete).toBe(false);
    expect(e.gaps.every((g) => g.detail.includes('REQ-7 has no current revision yet.'))).toBe(true);
  });
});

describe('the acceptance checklist, read from the delivery', () => {
  const accept = (...args: Parameters<typeof acceptanceAnswersOf>) =>
    evaluateChecklist(REQUIREMENT_ACCEPTANCE_CHECKLIST, {
      given: {},
      record: acceptanceAnswersOf(...args),
    });

  it('is complete when every issue shipped, every BC passes and each verdict cites evidence', () => {
    expect(
      accept({ liveIssues: 2, unshipped: [], shipped: false, unproven: [] }, []).complete,
    ).toBe(true);
  });

  it('names an unshipped issue, an unproven BC with its reason, and an uncited verdict', () => {
    const e = accept(
      {
        liveIssues: 2,
        unshipped: ['ISS-9'],
        shipped: false,
        unproven: [
          { code: 'BC-2', verdict: 'not_judged', why: 'the live build could not be read' },
          { code: 'BC-4', verdict: 'gap', why: null },
        ],
      },
      [{ issue: 'ISS-3', criterion: 1 }],
    );
    const by = Object.fromEntries(checklistRefusals(e).map((r) => [r.question, r.detail]));
    expect(by.shipped).toContain('ISS-9 has not shipped.');
    expect(by.verdicts).toContain(
      'BC-2 (not judged: the live build could not be read); BC-4 (gap)',
    );
    expect(by.evidence).toContain('ISS-3 criterion 1');
  });

  it('refuses a requirement no live issue delivers', () => {
    const e = accept({ liveIssues: 0, unshipped: [], shipped: false, unproven: [] }, []);
    expect(checklistRefusals(e).map((r) => r.question)).toEqual(['shipped']);
  });
});
