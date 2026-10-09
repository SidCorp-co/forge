// The breakdown checklist as a suggestion's record answers it (REQ-34 r2 BC-1; Requirement
// lifecycle r15 breakdown_check): every current business criterion traced or listed uncovered with
// a reason, each issue's criteria tracing a current one, and a suggestion of another kind asked
// nothing beyond its kind.

import { BREAKDOWN_CHECKLIST } from '@forge/contracts/checklist-registry';
import { checklistRefusals, evaluateChecklist } from '@forge/contracts/checklists';
import { describe, expect, it } from 'vitest';
import { type BreakdownFacts, breakdownAnswersOf } from './breakdown-checklist-record.js';

const issue = (tracesTo: string[]) => ({
  title: 'Slice',
  complexity: 's' as const,
  criteria: tracesTo.map((t) => ({ body: `holds ${t}`, tracesTo: t })),
});

const facts = (payload: BreakdownFacts['payload']): BreakdownFacts => ({
  key: 'REQ-4',
  revision: 2,
  live: ['BC-1', 'BC-2', 'BC-3'],
  payload,
});

const judge = (f: BreakdownFacts) =>
  evaluateChecklist(BREAKDOWN_CHECKLIST, { given: {}, record: breakdownAnswersOf(f) });

describe('the breakdown checklist, read from the proposed breakdown', () => {
  it('is complete when every current BC is traced or listed uncovered with a reason', () => {
    const e = judge(
      facts({
        issues: [issue(['BC-1']), issue(['BC-2'])],
        uncovered: [{ code: 'BC-3', reason: 'needs the owner first' }],
      }),
    );
    expect(e.complete).toBe(true);
    expect(e.answers.find((a) => a.question === 'coverage')?.value).toBe(
      'BC-1, BC-2 traced; BC-3 listed uncovered with a reason.',
    );
  });

  it('names a BC neither traced nor listed, one listed with no reason, and one not current', () => {
    const e = judge(
      facts({
        issues: [issue(['BC-1'])],
        uncovered: [
          { code: 'BC-2', reason: '  ' },
          { code: 'BC-9', reason: 'gone' },
        ],
      }),
    );
    const [coverage] = checklistRefusals(e);
    expect(coverage?.question).toBe('coverage');
    expect(coverage?.detail).toContain('Neither traced nor listed uncovered: BC-2, BC-3.');
    expect(coverage?.detail).toContain('Listed uncovered with no reason: BC-2.');
    expect(coverage?.detail).toContain(
      'not a current business criterion of REQ-4 revision 2: BC-9.',
    );
  });

  it('names an issue whose criterion traces no current BC', () => {
    const refusals = checklistRefusals(
      judge(facts({ issues: [issue(['BC-1', 'BC-2', 'BC-3', 'BC-7'])] })),
    );
    expect(refusals.map((r) => r.question)).toEqual(['criteria']);
    expect(refusals[0]?.detail).toContain('issue 1 traces BC-7');
  });

  it('asks a suggestion of another kind nothing but its kind', () => {
    const e = evaluateChecklist(BREAKDOWN_CHECKLIST, {
      given: {},
      record: { kind: { value: 'other' } },
    });
    expect(e.complete).toBe(true);
    expect(e.notAsked).toEqual(['criteria', 'coverage', 'complexity']);
  });
});
