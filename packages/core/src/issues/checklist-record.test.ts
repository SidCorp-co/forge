// REQ-34 BC-18: what the issue-ready record reader says is missing, and what clears it, is read by a
// person on every door. Each sentence it can write is read here against the contract's one rule for
// a field key in a sentence (`fieldKeyShownIn`), and through `evaluateChecklist`, which refuses to
// judge with a reader whose words show one.

import { ISSUE_READY_CHECKLIST } from '@forge/contracts/checklist-registry';
import { evaluateChecklist, fieldKeyShownIn, type RecordAnswer } from '@forge/contracts/checklists';
import { describe, expect, it } from 'vitest';
import {
  type CriterionTrace,
  criteriaAnswerOf,
  type Planned,
  requirementAnswer,
} from './checklist-record.js';

const planned = (over: Partial<Planned>): Planned => ({
  key: 'REQ-7',
  status: 'agreed',
  plannedRevision: 3,
  hasPlan: true,
  ...over,
});

const REQUIREMENT_STATES: Planned[] = [
  planned({ key: null, status: null, plannedRevision: null, hasPlan: false }),
  planned({ key: null, status: null, plannedRevision: null, hasPlan: true }),
  planned({ status: 'draft' }),
  planned({ status: 'dropped' }),
  planned({ status: 'deferred' }),
  planned({ plannedRevision: null, hasPlan: true }),
  planned({ plannedRevision: null, hasPlan: false }),
  planned({}),
];

const trace = (
  n: number,
  traced: boolean | null,
  code: string | null = 'BC-1',
): CriterionTrace => ({
  n,
  code,
  traced,
});

const CRITERIA_STATES: [CriterionTrace[], Planned][] = [
  [[], planned({})],
  [[trace(1, true)], planned({ key: null, plannedRevision: null })],
  [[trace(1, true), trace(2, true)], planned({ plannedRevision: null })],
  [[trace(1, false)], planned({})],
  [[trace(1, true), trace(2, null, null), trace(3, false)], planned({})],
  [[trace(1, true)], planned({})],
  [[trace(1, true, 'BC-1'), trace(2, true, 'BC-2')], planned({})],
];

/** Every answer the reader can give, from every state it reads. */
const EVERY_ANSWER: RecordAnswer[] = [
  ...REQUIREMENT_STATES.map(requirementAnswer),
  ...CRITERIA_STATES.map(([rows, p]) => criteriaAnswerOf(rows, p)),
];

const sentencesOf = (a: RecordAnswer) => ('gap' in a ? [a.gap, a.fix] : []);

describe("the issue-ready record reader's words", () => {
  // six requirement gaps (not linked; draft, dropped, deferred; planned before the link; no plan) and
  // five criteria gaps (none; no plan, for one criterion and for two; one untraced; several untraced)
  // are each read below
  it('reach every gap it can name', () => {
    const gaps = new Set(EVERY_ANSWER.flatMap((a) => ('gap' in a ? [a.gap] : [])));
    expect(gaps.size).toBe(11);
  });

  it('never show a record field key or code formatting', () => {
    for (const sentence of EVERY_ANSWER.flatMap(sentencesOf)) {
      expect(fieldKeyShownIn(ISSUE_READY_CHECKLIST, sentence), sentence).toBeNull();
    }
  });

  it('are judged by the kernel without a reader defect, each gap naming its question', () => {
    const value = { value: 'x' };
    for (const requirement of REQUIREMENT_STATES.map(requirementAnswer)) {
      for (const [rows, p] of CRITERIA_STATES) {
        const evaluation = evaluateChecklist(ISSUE_READY_CHECKLIST, {
          given: {},
          record: { requirement, criteria: criteriaAnswerOf(rows, p), design: value },
        });
        for (const gap of evaluation.gaps) expect(gap.path).toBe(`/answers/${gap.question}`);
      }
    }
  });

  it('count one criterion as "1 criterion"', () => {
    const one = criteriaAnswerOf([trace(1, true)], planned({ plannedRevision: null }));
    expect('gap' in one && one.gap).toBe(
      'Its 1 criterion cannot be traced yet, because the issue has no plan written against a requirement revision.',
    );
  });
});
